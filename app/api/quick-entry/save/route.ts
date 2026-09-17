import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { upsertManualEntry } from "@/lib/metrics/manual-entry";
import {
  consultPolicy,
  divergencePct,
  isDivergenceFlagged,
} from "@/lib/policy/registry";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { markTapActed } from "@/lib/daily-tap/read";
import { todayManila } from "@/lib/metrics/windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ENTITY_TYPES = new Set(["metric_entry", "daily_report", "live_session"]);
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024; // 25 MB — covers short capture videos
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = { from: (t: string) => any };

// Parse a form field into a finite number, or null when blank. Anything else is
// a hard error — we never coerce garbage to 0 (honest nulls).
function parseNumber(raw: FormDataEntryValue | null): { value: number | null } | { error: string } {
  if (raw == null || raw === "") return { value: null };
  const s = String(raw).trim();
  if (s === "") return { value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: "value must be a number" };
  return { value: n };
}

// POST /api/quick-entry/save — the ONE consequential-save chokepoint for the
// mobile Quick-Entry flow (multipart form). It:
//   1. CONSULTS policy_registry before doing anything consequential;
//   2. refuses to commit unless the human CONFIRMED (vision never auto-saves);
//   3. writes the metric floor through the sanctioned manual path (honest nulls,
//      manual/api columns kept apart);
//   4. FLAGS a typed value that diverges from the machine reading past the policy
//      threshold (the metric-mismatch idea at capture time);
//   5. stores the capture in the private 'evidence' bucket and records an
//      evidence_attachments row — with its source_url and the machine reading —
//      attached to the metric entry / daily report / live session it belongs to.
//
// Any authenticated org member may save (team write); RLS is the real boundary.
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const entityType = String(form.get("entity_type") ?? "");
  if (!ENTITY_TYPES.has(entityType)) {
    return NextResponse.json({ error: "Unknown entity_type." }, { status: 400 });
  }

  const confirmed = String(form.get("confirmed") ?? "") === "true";

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // ── 1. Consult policy BEFORE any consequential write ────────────────────────
  const policy = await consultPolicy(db, "evidence_capture");

  // ── 2. Vision is a SUGGESTION — never auto-save ─────────────────────────────
  // The human must have confirmed; and the policy must not (it never does) permit
  // an auto-save. Either failing → refuse before touching a table.
  if (policy.requires_confirmation && !confirmed) {
    return NextResponse.json(
      { error: "Confirmation required — review the reading before saving.", policy: policySummary(policy) },
      { status: 400 }
    );
  }
  if (!confirmed && !policy.allow_auto_save) {
    return NextResponse.json(
      { error: "This save cannot commit without a human confirmation.", policy: policySummary(policy) },
      { status: 400 }
    );
  }

  // The machine reading the user saw (echoed back so the evidence records exactly
  // what was suggested). Parsed defensively — a bad blob is simply "no reading".
  let visionExtract: Record<string, unknown> | null = null;
  const rawExtract = form.get("vision_extract");
  if (typeof rawExtract === "string" && rawExtract.trim() !== "") {
    try {
      const parsed = JSON.parse(rawExtract);
      if (parsed && typeof parsed === "object") visionExtract = parsed as Record<string, unknown>;
    } catch {
      visionExtract = null;
    }
  }
  const extractedValue =
    visionExtract && typeof visionExtract.value === "number" && Number.isFinite(visionExtract.value)
      ? (visionExtract.value as number)
      : null;

  // ── 3. Resolve the entity + (for a metric) write the floor ──────────────────
  let entityId: string | null = null;
  let typedValue: number | null = null;
  let entryAction: "updated" | "inserted" | null = null;

  if (entityType === "metric_entry") {
    const metric_key = String(form.get("metric_key") ?? "");
    const department = String(form.get("department") ?? "");
    const period_start = String(form.get("period_start") ?? "");
    const period_end = String(form.get("period_end") ?? "");
    const rawBrand = form.get("brand_id");
    const brand_id =
      typeof rawBrand === "string" && rawBrand !== "" && rawBrand !== "shop" ? rawBrand : null;
    const note = typeof form.get("note") === "string" ? (form.get("note") as string) : null;

    const parsed = parseNumber(form.get("typed_value"));
    if ("error" in parsed) {
      return NextResponse.json({ error: "typed_value must be a number." }, { status: 400 });
    }
    typedValue = parsed.value;
    if (typedValue == null) {
      return NextResponse.json({ error: "A value is required to save a metric entry." }, { status: 400 });
    }
    // department is the metric_catalog.department TEXT name that rode in on the
    // chosen metric (never a uuid, never a hardcoded code). upsertManualEntry
    // verifies the metric actually belongs to it, so a non-empty string is all we
    // gate on here — matching the standalone grid's /api/quick-entry/bulk path.
    if (!metric_key || !department || !isDateStr(period_start) || !isDateStr(period_end)) {
      return NextResponse.json(
        { error: "metric_key, department, period_start, period_end are required." },
        { status: 400 }
      );
    }

    // Sanctioned manual-floor upsert (shared with /api/metrics/entries). Writes
    // ONLY manual_value — api_value is never touched here.
    const result = await upsertManualEntry(supabase, profile, {
      metric_key,
      department,
      brand_id,
      period_start,
      period_end,
      manual_value: typedValue,
      note,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    entityId = result.id;
    entryAction = result.action;
    if (!entityId) {
      return NextResponse.json({ error: "Could not resolve the saved entry." }, { status: 500 });
    }
  } else {
    // daily_report / live_session — attaching evidence to an existing row. The
    // caller supplies its id; RLS still scopes every read/write to the org.
    const eid = String(form.get("entity_id") ?? "");
    if (!UUID_RE.test(eid)) {
      return NextResponse.json({ error: "A valid entity_id is required." }, { status: 400 });
    }
    if (entityType === "live_session") {
      // Best-effort existence check under RLS (org-scoped) so we don't attach to
      // a session outside the caller's org.
      const { data } = await db.from("live_sessions").select("id").eq("id", eid).maybeSingle();
      if (!data) {
        return NextResponse.json({ error: "Live session not found." }, { status: 404 });
      }
    }
    entityId = eid;
    const parsed = parseNumber(form.get("typed_value"));
    typedValue = "error" in parsed ? null : parsed.value;
  }

  // ── 4. Divergence flag (typed vs machine reading, per policy threshold) ──────
  const divPct = divergencePct(typedValue, extractedValue);
  const flagged = isDivergenceFlagged(typedValue, extractedValue, policy);

  // ── 5. Store the capture + record the evidence row ──────────────────────────
  const file = form.get("file");
  const sourceUrl = typeof form.get("source_url") === "string" ? (form.get("source_url") as string).trim() : "";
  const rawKind = String(form.get("kind") ?? "").trim();

  let evidenceId: string | null = null;
  let evidenceError: string | null = null;

  const hasFile = file instanceof File && file.size > 0;
  if (hasFile || sourceUrl) {
    // The machine reading + the human's number, recorded side by side. This is a
    // SUGGESTION trail next to the confirmed value — never a competing truth.
    const visionRecord = {
      source: "quick_entry",
      extracted: visionExtract,
      typed_value: typedValue,
      divergence_pct: divPct,
      flagged,
      threshold_pct: policy.divergence_threshold_pct,
      policy_key: policy.key,
    };

    let url = "";
    let kind = normalizeKind(rawKind, hasFile ? (file as File).type : null, Boolean(sourceUrl));

    if (hasFile) {
      const f = file as File;
      if (f.size > MAX_EVIDENCE_BYTES) {
        return NextResponse.json({ error: "Capture is too large (max 25 MB)." }, { status: 413 });
      }
      const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "capture";
      const path = `${profile.org_id}/${entityType}/${entityId}/${Date.now()}_${safe}`;
      const buf = Buffer.from(await f.arrayBuffer());
      const { error: upErr } = await supabase.storage
        .from("evidence")
        .upload(path, buf, { contentType: f.type || "application/octet-stream", upsert: false });
      if (upErr) {
        // The metric floor is already saved; surface the evidence failure without
        // pretending the capture was stored (honest partial result).
        evidenceError = upErr.message;
      } else {
        url = path;
      }
    } else {
      url = sourceUrl;
      kind = "link";
    }

    if (url) {
      const { data: inserted, error: insErr } = await db
        .from("evidence_attachments")
        .insert({
          org_id: profile.org_id,
          entity_type: entityType,
          entity_id: entityId,
          url,
          kind,
          source_url: sourceUrl || null,
          vision_extract: visionRecord,
          uploaded_by: profile.id,
        } as never)
        .select("id")
        .maybeSingle();
      if (insErr) {
        evidenceError = insErr.message;
        // Roll back the stored object so we don't orphan it (only bucket paths).
        if (hasFile && url && !/^https?:\/\//i.test(url)) {
          try {
            await supabase.storage.from("evidence").remove([url]);
          } catch {
            /* best-effort */
          }
        }
      } else {
        evidenceId = (inserted as { id: string } | null)?.id ?? null;
      }
    }
  }

  // Logging today's Quick Entry IS acting on the daily tap — mark it acted so the
  // in-app snooze nudges stop. Best-effort and self-scoped (the verified session
  // user); daily_taps is RLS-with-no-policy, so this write uses the service-role
  // client. A failure here never affects the save result.
  try {
    const svc = createServiceRoleClient() as unknown as Db;
    await markTapActed(svc, profile.id, profile.org_id, todayManila());
  } catch {
    /* best-effort — the tap-acted mark must never break a metric save */
  }

  return NextResponse.json({
    ok: true,
    entity_type: entityType,
    entity_id: entityId,
    entry_action: entryAction,
    evidence_id: evidenceId,
    evidence_error: evidenceError,
    divergence: { pct: divPct, flagged, threshold_pct: policy.divergence_threshold_pct },
    policy: policySummary(policy),
  });
}

// Narrow date check (YYYY-MM-DD), matching the metrics routes' isValidDate.
function isDateStr(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime());
}

// Kind is one of photo/video/screenshot/link. A caller hint wins when valid; else
// infer from the mime type (video/* → video, image/* → photo) or link presence.
function normalizeKind(
  hint: string,
  mime: string | null,
  isLink: boolean
): "photo" | "video" | "screenshot" | "link" {
  if (hint === "photo" || hint === "video" || hint === "screenshot" || hint === "link") return hint;
  if (mime && mime.startsWith("video/")) return "video";
  if (mime && mime.startsWith("image/")) return "photo";
  if (isLink) return "link";
  return "photo";
}

function policySummary(p: {
  key: string;
  requires_confirmation: boolean;
  allow_auto_save: boolean;
  divergence_threshold_pct: number;
  resolved: boolean;
}) {
  return {
    key: p.key,
    consulted: true,
    resolved: p.resolved,
    requires_confirmation: p.requires_confirmation,
    allow_auto_save: p.allow_auto_save,
    divergence_threshold_pct: p.divergence_threshold_pct,
  };
}
