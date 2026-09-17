"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AddAnchorState } from "./AddAnchorForm";

// Server actions for the Live Selling module — anchor registry CRUD and live
// session log/edit. Every write is org/RLS-scoped: the row's org_id is set from
// the caller's profile so it satisfies the live_sessions / anchors
// with_check (org_id = current_org_id()) policy. Nothing is fabricated — a
// left-blank metric is stored as null (unknown), never a zero.
//
// Live selling is a marketing-ops surface, so heads and members can manage it
// (mirroring the Creators portal), not just leadership.

const MANAGE_ROLES = ["ceo", "coo", "department_head", "team_member"] as const;

// The generated Database types don't include anchors / live_sessions yet, so we
// reach them through the same cast shim used across the app. Reads/writes only.
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
    delete: () => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
  };
};

// Parse an optional numeric field: blank → null (unknown), never 0. Integers are
// truncated; money/rate fields keep their decimals.
function optNum(formData: FormData, key: string, integer = false): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return integer ? Math.trunc(n) : n;
}

// Parse a demographics facet entered as "bucket:weight, bucket:weight"
// (e.g. "18-24:30, 25-34:45") into a { bucket: weight } map, or null when blank
// / unparseable. Non-numeric or non-positive weights are dropped.
function parseDemoField(formData: FormData, key: string): Record<string, number> | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const out: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const idx = part.lastIndexOf(":");
    if (idx < 0) continue;
    const label = part.slice(0, idx).trim();
    const weight = Number(part.slice(idx + 1).trim());
    if (!label || !Number.isFinite(weight) || weight <= 0) continue;
    out[label] = weight;
  }
  return Object.keys(out).length ? out : null;
}

// Assemble the demographics jsonb from the three facet fields, or null when all
// are empty (so an untouched form never writes an empty object).
function buildDemographics(formData: FormData): Record<string, unknown> | null {
  const age = parseDemoField(formData, "demo_age");
  const gender = parseDemoField(formData, "demo_gender");
  const location = parseDemoField(formData, "demo_location");
  if (!age && !gender && !location) return null;
  const demo: Record<string, unknown> = {};
  if (age) demo.age = age;
  if (gender) demo.gender = gender;
  if (location) demo.location = location;
  return demo;
}

// A datetime-local value ("2026-07-12T14:30") → ISO, or null. The input is
// timezone-naive; we pin it to Asia/Manila (the company timezone, fixed +08:00)
// so the wall-clock the user typed round-trips exactly regardless of where the
// server renders. A value that already carries a zone is honoured as-is.
function optTimestamp(formData: FormData, key: string): string | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/);
  if (!m) return null;
  const t = new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}+08:00`).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ── Anchors (registry CRUD) ────────────────────────────────────────────────

// A Postgres unique-constraint violation (code 23505) — the DB backstop firing.
// Recognised so the UI can show a friendly "already exists" instead of the raw
// constraint error, never a stack trace.
function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("duplicate key") || m.includes("unique constraint");
}

// The ONLY path that INSERTs an anchor. Before inserting it blocks a second
// anchor that shares a normalized handle on the same platform in the org — that
// is how a duplicate anchor is born and must never happen here. The DB unique
// index on (org_id, lower(handle), platform) is the last-line backstop; this
// gives a clear inline message instead of an opaque constraint error. Editing an
// anchor goes through updateAnchor (UPDATE by id) and never reaches here. Shaped
// for useFormState so the block/error surfaces inline. Handle is optional — an
// anchor with no handle is never deduped (the index treats nulls as distinct too).
export async function createAnchor(
  _prev: AddAnchorState,
  formData: FormData
): Promise<AddAnchorState> {
  const profile = (await requireRole([...MANAGE_ROLES])) as unknown as { id: string; org_id: string };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Anchor name is required." };
  const anchorType = String(formData.get("anchor_type") ?? "inhouse") || "inhouse";
  // Only affiliate anchors carry a linked creator.
  const creatorId = anchorType === "affiliate" ? String(formData.get("creator_id") ?? "") || null : null;
  const handle = String(formData.get("handle") ?? "").trim() || null;
  const platform = String(formData.get("platform") ?? "tiktok") || "tiktok";
  const supabase = createServerSupabaseClient();

  // Duplicate guard: normalized handle + platform match against anchors in this
  // org. Only runs when a handle is given, mirroring the partial-null semantics of
  // the (org_id, lower(handle), platform) unique index.
  if (handle) {
    const normalized = handle.toLowerCase();
    const { data: existing } = await (supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (col: string, val: string) => Promise<{ data: unknown }>;
        };
      };
    })
      .from("anchors")
      .select("id, handle, platform")
      .eq("org_id", profile.org_id);
    const dup = ((existing as { handle: string | null; platform: string | null }[] | null) ?? []).find(
      (r) => (r.handle ?? "").trim().toLowerCase() === normalized && (r.platform ?? "") === platform
    );
    if (dup) {
      return {
        error: `An anchor with the handle "${handle}" on this platform already exists — open it to edit instead of adding a new one.`,
      };
    }
  }

  const { error } = await (supabase as unknown as DbShim).from("anchors").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    name,
    handle,
    platform,
    anchor_type: anchorType,
    creator_id: creatorId,
    status: "active",
    notes: String(formData.get("notes") ?? "").trim() || null,
  });
  if (error) {
    // Backstop: the unique index rejected a race that slipped past the check.
    if (isUniqueViolation(error as { code?: string; message?: string })) {
      return {
        error: `An anchor with the handle "${handle ?? ""}" on this platform already exists — open it to edit instead of adding a new one.`,
      };
    }
    return { error: "Could not add the anchor. Please try again." };
  }
  revalidatePath("/live");
  return null;
}

export async function updateAnchor(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  // Save ALWAYS updates the opened anchor by its id — it never inserts. With no id
  // we bail rather than fall through to any create path, so an absent/empty id can
  // never silently mint a duplicate.
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const anchorType = String(formData.get("anchor_type") ?? "inhouse") || "inhouse";
  const creatorId = anchorType === "affiliate" ? String(formData.get("creator_id") ?? "") || null : null;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("anchors")
    .update({
      status: String(formData.get("status") ?? "active") || "active",
      anchor_type: anchorType,
      creator_id: creatorId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/live");
}

export async function deleteAnchor(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  // If the anchor is still referenced by sessions the FK may block the delete;
  // that's fine — the row simply stays. Callers can set it inactive instead.
  await (supabase as unknown as DbShim).from("anchors").delete().eq("id", id);
  revalidatePath("/live");
}

// ── Live sessions (log / edit) ───────────────────────────────────────────────
//
// SYNC-READY CONTRACT ─────────────────────────────────────────────────────────
// Every write from this UI is a MANUAL record: `source = 'manual'` and
// `external_id = null` (a human-logged session has no platform primary key).
//
// The write path is intentionally shaped so a future platform feed can flow in
// WITHOUT touching this UI. A TikTok Shop LIVE sync would land its rows through a
// separate server path (an API route / cron), tagging each with the platform's
// own id and `source = 'tiktok_api'`, and UPSERT on the natural key
// (org_id, external_id) so the same live re-synced updates the existing row
// instead of duplicating it. Manual rows carry a null external_id, so they never
// collide with synced rows on that key and both sources coexist per brand.
//
//   TODO(platform-sync): when the TikTok Live Data scope is live, add a
//   syncLiveSessions() writer that upserts { ...metrics, source: 'tiktok_api',
//   external_id: <platform live id> } on the (org_id, external_id) conflict
//   target. Do not route it through these manual actions — keep the two paths
//   separate so a sync never overwrites a hand-entered field it doesn't own.
// ──────────────────────────────────────────────────────────────────────────────

export async function createSession(formData: FormData) {
  const profile = (await requireRole([...MANAGE_ROLES])) as unknown as { id: string; org_id: string };
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("live_sessions").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    brand_id: String(formData.get("brand_id") ?? "") || null,
    anchor_id: String(formData.get("anchor_id") ?? "") || null,
    platform: String(formData.get("platform") ?? "tiktok_shop") || "tiktok_shop",
    title: String(formData.get("title") ?? "").trim() || null,
    status: String(formData.get("status") ?? "scheduled") || "scheduled",
    started_at: optTimestamp(formData, "started_at"),
    ended_at: optTimestamp(formData, "ended_at"),
    duration_minutes: optNum(formData, "duration_minutes"),
    gmv: optNum(formData, "gmv"),
    attributed_gmv: optNum(formData, "attributed_gmv"),
    units_sold: optNum(formData, "units_sold", true),
    products_sold: optNum(formData, "products_sold", true),
    impressions: optNum(formData, "impressions", true),
    clicks: optNum(formData, "clicks", true),
    orders: optNum(formData, "orders", true),
    ctr: optNum(formData, "ctr"),
    ctor: optNum(formData, "ctor"),
    peak_viewers: optNum(formData, "peak_viewers", true),
    avg_viewers: optNum(formData, "avg_viewers", true),
    demographics: buildDemographics(formData),
    notes: String(formData.get("notes") ?? "").trim() || null,
    // Manual write: no platform primary key. A future tiktok_api sync sets these
    // two on the separate write path (see SYNC-READY CONTRACT above).
    external_id: null,
    source: "manual",
  });
  revalidatePath("/live");
}

// ── One-tap live capture (PR 6) ──────────────────────────────────────────────
//
// A mobile-first, single-tap START LIVE for someone mid-stream with their hands
// full. START opens a live_sessions row (status='live', started_at=now,
// source='manual', external_id=NULL) and shows it in the existing LIVE NOW strip
// with its ticking elapsed timer; the per-anchor scorecard picks it up the moment
// a host is attached. END reuses setSessionStatus('ended') below (stamps ended_at
// now, idempotent). GMV / viewers / CTOR are deliberately left NULL so every
// surface renders an honest "—", never a fabricated 0 — and a post-live GMV typed
// via updateLiveMetrics is a per-session operational figure only, never a second
// revenue source (canonical GMV always comes from tiktok_shop_performance).

// Find an anchor by normalized name in this org, or create one, returning its id.
// Lets START LIVE fill the anchor registry from the capture control, so a host
// typed once becomes a reusable, scorecard-tracked anchor. Mirrors the
// createAnchor insert shape (in-house, active) minus the handle-dedup path.
async function selectOrCreateAnchor(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  profile: { id: string; org_id: string },
  name: string
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const u = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, val: string) => Promise<{ data: { id: string; name: string | null }[] | null }>;
      };
      insert: (v: Record<string, unknown>) => {
        select: (c: string) => { single: () => Promise<{ data: { id: string } | null }> };
      };
    };
  };
  const { data: existing } = await u.from("anchors").select("id, name").eq("org_id", profile.org_id);
  const normalized = trimmed.toLowerCase();
  const match = ((existing ?? []) as { id: string; name: string | null }[]).find(
    (a) => (a.name ?? "").trim().toLowerCase() === normalized
  );
  if (match) return match.id;
  const { data: created } = await u
    .from("anchors")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      name: trimmed,
      platform: "tiktok",
      anchor_type: "inhouse",
      status: "active",
    })
    .select("id")
    .single();
  return created?.id ?? null;
}

// START LIVE — the one-tap capture. Resolves a host (an existing anchor id, or a
// name typed into the control → create-or-select), then opens ONE live session.
// A host is required (anchor_id = host); with none resolved it is a no-op rather
// than minting an anchor-less live. Idempotent: if the anchor already has an open
// session it surfaces the running one instead of creating a second, and the
// live_sessions_one_open_per_anchor partial unique index is the race backstop.
export async function startLive(formData: FormData) {
  const profile = (await requireRole([...MANAGE_ROLES])) as unknown as { id: string; org_id: string };
  const supabase = createServerSupabaseClient();

  let anchorId = String(formData.get("anchor_id") ?? "").trim() || null;
  if (!anchorId) {
    anchorId = await selectOrCreateAnchor(supabase, profile, String(formData.get("host_name") ?? ""));
  }
  // No host → nothing to open. Keeps every live row anchored to a real host.
  if (!anchorId) {
    revalidatePath("/live");
    return;
  }

  const brandId = String(formData.get("brand_id") ?? "").trim() || null;
  const title = String(formData.get("title") ?? "").trim() || null;
  const platform = String(formData.get("platform") ?? "tiktok_shop") || "tiktok_shop";

  // App-level idempotency: an anchor that is already live keeps its one session.
  const uSel = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c1: string, v1: string) => {
          eq: (c2: string, v2: string) => {
            eq: (c3: string, v3: string) => Promise<{ data: { id: string }[] | null }>;
          };
        };
      };
    };
  };
  const { data: open } = await uSel
    .from("live_sessions")
    .select("id")
    .eq("org_id", profile.org_id)
    .eq("anchor_id", anchorId)
    .eq("status", "live");
  if (((open ?? []) as { id: string }[]).length > 0) {
    revalidatePath("/live");
    return;
  }

  const { error } = await (supabase as unknown as DbShim).from("live_sessions").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    brand_id: brandId,
    anchor_id: anchorId,
    platform,
    title,
    status: "live",
    started_at: new Date().toISOString(),
    // GMV / attributed_gmv / viewers / ctor left unset → stored NULL → render "—".
    external_id: null,
    source: "manual",
  });
  // A double-tap that beat the app check trips the partial unique index (23505):
  // the existing open session stands, so treat it as an idempotent no-op.
  void (error && isUniqueViolation(error as { code?: string; message?: string }));
  revalidatePath("/live");
}

export async function updateSession(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("live_sessions")
    .update({
      brand_id: String(formData.get("brand_id") ?? "") || null,
      anchor_id: String(formData.get("anchor_id") ?? "") || null,
      title: String(formData.get("title") ?? "").trim() || null,
      status: String(formData.get("status") ?? "scheduled") || "scheduled",
      started_at: optTimestamp(formData, "started_at"),
      ended_at: optTimestamp(formData, "ended_at"),
      duration_minutes: optNum(formData, "duration_minutes"),
      gmv: optNum(formData, "gmv"),
      attributed_gmv: optNum(formData, "attributed_gmv"),
      units_sold: optNum(formData, "units_sold", true),
      products_sold: optNum(formData, "products_sold", true),
      impressions: optNum(formData, "impressions", true),
      clicks: optNum(formData, "clicks", true),
      orders: optNum(formData, "orders", true),
      ctr: optNum(formData, "ctr"),
      ctor: optNum(formData, "ctor"),
      peak_viewers: optNum(formData, "peak_viewers", true),
      avg_viewers: optNum(formData, "avg_viewers", true),
      demographics: buildDemographics(formData),
      notes: String(formData.get("notes") ?? "").trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/live");
  revalidatePath(`/live/${id}`);
}

// Live-now inline update: while a session is running, refresh only the
// as-it-happens metrics (GMV, orders, peak/avg viewers, units) straight from the
// "Live now" card without opening the full editor. Each field is prefilled with
// its current value; a field cleared to blank is written back as null (unknown),
// never a fabricated zero. This is the real-time-via-human path — a person reads
// the live dashboard on the platform and types the current figures here.
export async function updateLiveMetrics(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("live_sessions")
    .update({
      gmv: optNum(formData, "gmv"),
      attributed_gmv: optNum(formData, "attributed_gmv"),
      orders: optNum(formData, "orders", true),
      units_sold: optNum(formData, "units_sold", true),
      peak_viewers: optNum(formData, "peak_viewers", true),
      avg_viewers: optNum(formData, "avg_viewers", true),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/live");
  revalidatePath(`/live/${id}`);
}

// Quick status flip from the sessions table (scheduled → live → ended) without
// opening the full editor. When ending a session, stamp ended_at if it's blank.
export async function setSessionStatus(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !["scheduled", "live", "ended"].includes(status)) return;
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  // Starting a live session with no start time stamps it now; ending stamps the
  // end now. Both are real event times, not invented metrics.
  if (status === "live" && String(formData.get("started_at") ?? "") === "") {
    patch.started_at = new Date().toISOString();
  }
  if (status === "ended" && String(formData.get("ended_at") ?? "") === "") {
    patch.ended_at = new Date().toISOString();
  }
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("live_sessions").update(patch).eq("id", id);
  revalidatePath("/live");
}

export async function deleteSession(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  const redirectTo = String(formData.get("redirect_to") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("live_sessions").delete().eq("id", id);
  revalidatePath("/live");
  if (redirectTo) redirect(redirectTo);
}
