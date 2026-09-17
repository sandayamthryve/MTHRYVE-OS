"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import { generateLiveBrief, type LiveBriefContext } from "@/lib/live-ops/brief";
import { buildRecommendationDraft } from "@/lib/briefings/account-review-action";
import type { BriefPayload } from "@/lib/briefings/account-review";
import { isBottleneckCategory, CATEGORY_DEPARTMENT, CATEGORY_LABEL } from "@/lib/live-ops/bottlenecks";
import { manilaDateOf } from "@/lib/metrics/live";
import type { LiveSession } from "@/lib/metrics/live";
import type { LiveBottleneck } from "@/lib/live-ops/bottlenecks";

// Server actions for the Live Operations module.
//
// One home per fact: every live metric is written to live_sessions ONLY —
// dashboards aggregate it, nothing is re-encoded into metric_entries. Manual
// hand-entry tags source='manual' and NEVER silently overwrites a synced 'api'
// value (a divergence is recorded + flagged instead). Money never auto-moves:
// AI recommendations only ever stage PENDING action_requests. Every write is
// org/RLS-scoped from the caller's profile.
//
// Live Operations is an ops surface — heads and members manage it (mirroring
// the Live Selling module); leadership-only steps (review, routing to approval)
// are gated explicitly and by RLS/guard triggers.

const MANAGE_ROLES = ["ceo", "coo", "department_head", "team_member"] as const;
const LEAD_ROLES = ["ceo", "coo", "department_head"] as const;

type DbShim = { from: (t: string) => any; storage: any };

// blank → null (unknown), never 0. Integers truncate; money/rates keep decimals.
function optNum(fd: FormData, key: string, integer = false): number | null {
  const raw = String(fd.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return integer ? Math.trunc(n) : n;
}
function optText(fd: FormData, key: string): string | null {
  const v = String(fd.get(key) ?? "").trim();
  return v || null;
}

// datetime-local ("2026-07-12T14:30") → ISO pinned to Asia/Manila (+08:00), or
// null. A value already carrying a zone is honoured as-is.
function optTimestamp(fd: FormData, key: string): string | null {
  const raw = String(fd.get(key) ?? "").trim();
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

// The Session Assessment jsonb from the four qualitative fields.
function buildAssessment(fd: FormData): Record<string, string> {
  const a: Record<string, string> = {};
  for (const k of ["highlights", "challenges", "customer_insights", "competitor_obs"]) {
    const v = String(fd.get(`assessment_${k}`) ?? "").trim();
    if (v) a[k] = v;
  }
  return a;
}

// The standard-metric columns the report form surfaces (one input each — see
// lib/live-ops/fields.ts REPORT_FIELDS). Kept in one place so create + update
// agree and the divergence guard compares exactly these. Columns the form does
// NOT surface (e.g. attributed_gmv, products_sold, ctor — owned by the Live
// Selling module) are deliberately omitted so a report save never clobbers a
// value it doesn't own.
function metricPatch(fd: FormData): Record<string, unknown> {
  return {
    gmv: optNum(fd, "gmv"),
    total_sales: optNum(fd, "total_sales"),
    orders: optNum(fd, "orders", true),
    units_sold: optNum(fd, "units_sold", true),
    aov: optNum(fd, "aov"),
    conversion_rate: optNum(fd, "conversion_rate"),
    impressions: optNum(fd, "impressions", true),
    viewers: optNum(fd, "viewers", true),
    peak_viewers: optNum(fd, "peak_viewers", true),
    avg_viewers: optNum(fd, "avg_viewers", true),
    viewer_retention: optNum(fd, "viewer_retention"),
    returning_viewers: optNum(fd, "returning_viewers", true),
    new_followers: optNum(fd, "new_followers", true),
    product_clicks: optNum(fd, "product_clicks", true),
    clicks: optNum(fd, "clicks", true),
    ctr: optNum(fd, "ctr"),
    likes: optNum(fd, "likes", true),
    shares: optNum(fd, "shares", true),
    comments: optNum(fd, "comments", true),
    engagement_rate: optNum(fd, "engagement_rate"),
  };
}

// The Session Information (header) columns.
function headerPatch(fd: FormData): Record<string, unknown> {
  return {
    title: optText(fd, "title"),
    brand_id: optText(fd, "brand_id"),
    anchor_id: optText(fd, "anchor_id"),
    moderator_id: optText(fd, "moderator_id"),
    team_leader_id: optText(fd, "team_leader_id"),
    session_number: optText(fd, "session_number"),
    studio: optText(fd, "studio"),
    shift: optText(fd, "shift"),
    platform: String(fd.get("platform") ?? "tiktok_shop") || "tiktok_shop",
    started_at: optTimestamp(fd, "started_at"),
    ended_at: optTimestamp(fd, "ended_at"),
    duration_minutes: optNum(fd, "duration_minutes", true),
    expected_duration_minutes: optNum(fd, "expected_duration_minutes", true),
    featured_products: optText(fd, "featured_products"),
  };
}

// ── Create a Daily Live Report (one live_sessions row) ────────────────────────
export async function createLiveReport(formData: FormData) {
  const profile = await requireRole([...MANAGE_ROLES]);
  const supabase = createServerSupabaseClient();
  const assessment = buildAssessment(formData);
  const { data, error } = await (supabase as unknown as DbShim)
    .from("live_sessions")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      status: String(formData.get("status") ?? "scheduled") || "scheduled",
      report_status: "draft",
      source: "manual",
      external_id: null,
      assessment,
      ...headerPatch(formData),
      ...metricPatch(formData),
      notes: optText(formData, "notes"),
    })
    .select("id")
    .single();
  revalidatePath("/live-ops/reports");
  revalidatePath("/live-ops");
  if (!error && data?.id) redirect(`/live-ops/reports/${data.id}`);
}

// ── Update a report — the HYBRID save ─────────────────────────────────────────
// Manual hand-entry NEVER silently overwrites a synced 'api' value. If the row
// was last written by the platform (source in api/tiktok_api), we snapshot the
// prior api metric values into assessment._prior_api and record which fields the
// manual entry changed, then tag source='reconciled' so the divergence is
// visible — the api numbers are preserved, never clobbered in silence.
export async function updateLiveReport(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const { data: current } = await db.from("live_sessions").select("*").eq("id", id).maybeSingle();
  const cur = (current ?? {}) as Record<string, unknown>;
  const metrics = metricPatch(formData);
  const assessment = buildAssessment(formData);

  let source = "manual";
  const curSource = String(cur.source ?? "manual");
  if (curSource === "api" || curSource === "tiktok_api") {
    // Non-silent reconciliation: preserve the api snapshot + flag what changed.
    const priorApi: Record<string, unknown> = {};
    const diverged: Record<string, { api: unknown; manual: unknown }> = {};
    for (const [k, v] of Object.entries(metrics)) {
      priorApi[k] = cur[k] ?? null;
      if (v != null && cur[k] != null && Number(v) !== Number(cur[k])) {
        diverged[k] = { api: cur[k], manual: v };
      }
    }
    (assessment as Record<string, unknown>)._prior_api = priorApi;
    if (Object.keys(diverged).length) {
      (assessment as Record<string, unknown>)._divergence = diverged;
    }
    source = "reconciled";
  }

  await db
    .from("live_sessions")
    .update({
      ...headerPatch(formData),
      ...metrics,
      assessment,
      source,
      notes: optText(formData, "notes"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath(`/live-ops/reports/${id}`);
  revalidatePath("/live-ops/reports");
  revalidatePath("/live-ops");
}

// ── Submit a report → status transition + kick off the AI brief ───────────────
export async function submitLiveReport(formData: FormData) {
  const profile = await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  await db
    .from("live_sessions")
    .update({
      report_status: "submitted",
      report_submitted_at: new Date().toISOString(),
      report_submitted_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  // After submission, Claude analyzes quant + qual → a persisted brief. Best
  // effort: a generation failure never blocks the submit.
  try {
    await runLiveBrief(db, profile, id);
  } catch {
    /* brief generation is advisory; the submit stands regardless */
  }
  revalidatePath(`/live-ops/reports/${id}`);
  revalidatePath("/live-ops/reports");
  revalidatePath("/live-ops/bottlenecks");
}

// ── Leadership review (guard trigger enforces the role at the DB too) ─────────
export async function reviewLiveReport(formData: FormData) {
  const profile = await requireRole([...LEAD_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("live_sessions")
    .update({
      report_status: "reviewed",
      report_reviewed_at: new Date().toISOString(),
      report_reviewed_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath(`/live-ops/reports/${id}`);
  revalidatePath("/live-ops/reports");
}

export async function deleteLiveReport(formData: FormData) {
  await requireRole([...LEAD_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("live_sessions").delete().eq("id", id);
  revalidatePath("/live-ops/reports");
  redirect("/live-ops/reports");
}

// ── Attachments (upload to the private 'live-ops' bucket, org-folder scoped) ───
export async function addAttachment(formData: FormData) {
  const profile = await requireRole([...MANAGE_ROLES]);
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const file = formData.get("file");
  const link = String(formData.get("link") ?? "").trim();
  const kindInput = String(formData.get("kind") ?? "").trim() || null;

  if (file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0) {
    const f = file as File;
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${profile.org_id}/${sessionId}/${Date.now()}_${safe}`;
    const buf = Buffer.from(await f.arrayBuffer());
    const { error: upErr } = await supabase.storage
      .from("live-ops")
      .upload(path, buf, { contentType: f.type || "application/octet-stream", upsert: false });
    if (!upErr) {
      await db.from("live_session_attachments").insert({
        org_id: profile.org_id,
        session_id: sessionId,
        url: path,
        kind: kindInput ?? (f.type.startsWith("image/") ? "image" : "file"),
        uploaded_by: profile.id,
      });
    }
  } else if (link) {
    await db.from("live_session_attachments").insert({
      org_id: profile.org_id,
      session_id: sessionId,
      url: link,
      kind: kindInput ?? "link",
      uploaded_by: profile.id,
    });
  }
  revalidatePath(`/live-ops/reports/${sessionId}`);
}

export async function deleteAttachment(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  const sessionId = String(formData.get("session_id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;
  // Best-effort remove the stored object too (only if it's a bucket path).
  const { data: row } = await db.from("live_session_attachments").select("url").eq("id", id).maybeSingle();
  const url = (row as { url?: string } | null)?.url;
  if (url && !/^https?:\/\//i.test(url)) {
    try {
      await supabase.storage.from("live-ops").remove([url]);
    } catch {
      /* ignore */
    }
  }
  await db.from("live_session_attachments").delete().eq("id", id);
  revalidatePath(`/live-ops/reports/${sessionId}`);
}

// ── Bottlenecks: categorize, assign (creates a task), update status ───────────
export async function addBottleneck(formData: FormData) {
  const profile = await requireRole([...MANAGE_ROLES]);
  const sessionId = String(formData.get("session_id") ?? "");
  const category = String(formData.get("category") ?? "");
  if (!sessionId || !isBottleneckCategory(category)) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  // Inherit the session's brand so the dashboard can consolidate by brand.
  const { data: sess } = await db.from("live_sessions").select("brand_id").eq("id", sessionId).maybeSingle();
  const severity = String(formData.get("severity") ?? "medium") || "medium";
  await db.from("live_bottlenecks").insert({
    org_id: profile.org_id,
    session_id: sessionId,
    brand_id: (sess as { brand_id?: string } | null)?.brand_id ?? null,
    category,
    note: optText(formData, "note"),
    severity: ["low", "medium", "high", "critical"].includes(severity) ? severity : "medium",
    status: "open",
    assigned_dept: CATEGORY_DEPARTMENT[category] ?? null,
    created_by: profile.id,
  });
  revalidatePath(`/live-ops/reports/${sessionId}`);
  revalidatePath("/live-ops/bottlenecks");
}

// Assign a bottleneck to a department/person AND spin up a task (the "notify +
// record history" step). The created task is linked back on the row so the
// dashboard shows one is open, and the transition lands in action_audit.
export async function assignBottleneck(formData: FormData) {
  const profile = await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const { data: b } = await db.from("live_bottlenecks").select("*").eq("id", id).maybeSingle();
  if (!b) return;
  const row = b as LiveBottleneck;
  const dept = String(formData.get("assigned_dept") ?? "").trim() || row.assigned_dept || null;
  const assignee = optText(formData, "assigned_to");

  // Create the follow-up task (tasks RLS is org-open).
  const taskTitle = `Live bottleneck: ${CATEGORY_LABEL[row.category] ?? row.category}`;
  const { data: task } = await db
    .from("tasks")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      brand_id: row.brand_id,
      title: taskTitle,
      description: `${row.note ?? "Reported live-session bottleneck."}\n\nRouted from Live Operations · session ${row.session_id}${dept ? ` · dept ${dept}` : ""}.`,
      assignee_id: assignee,
      priority: row.severity === "critical" || row.severity === "high" ? "high" : "medium",
      status: "todo",
    })
    .select("id")
    .single();

  await db
    .from("live_bottlenecks")
    .update({
      status: "assigned",
      assigned_dept: dept,
      assigned_to: assignee,
      task_id: (task as { id?: string } | null)?.id ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  // History: reuse the action_audit trail.
  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: null,
    event: "created",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: {
      source: "live_bottleneck.assign",
      bottleneck_id: id,
      category: row.category,
      assigned_dept: dept,
      assigned_to: assignee,
      task_id: (task as { id?: string } | null)?.id ?? null,
    },
  });

  revalidatePath("/live-ops/bottlenecks");
  revalidatePath(`/live-ops/reports/${row.session_id}`);
}

export async function updateBottleneckStatus(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !["open", "assigned", "in_progress", "resolved", "dismissed"].includes(status)) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("live_bottlenecks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/live-ops/bottlenecks");
}

// ── AI brief: generate + persist (leadership triggers) ────────────────────────
export async function generateLiveAiBrief(formData: FormData) {
  const profile = await requireRole([...LEAD_ROLES]);
  const sessionId = String(formData.get("session_id") ?? "");
  if (!sessionId) return;
  const supabase = createServerSupabaseClient();
  await runLiveBrief(supabase as unknown as DbShim, profile, sessionId);
  revalidatePath(`/live-ops/reports/${sessionId}`);
}

// Shared brief runner: grounds Claude on the session + previous session +
// bottlenecks, then persists a BriefPayload to account_review_briefs
// (department 'Live Operations', scoped to the session/brand/period). Reused by
// submitLiveReport and the manual "Generate brief" button.
async function runLiveBrief(
  db: DbShim,
  profile: { id: string; org_id: string; role: string },
  sessionId: string
): Promise<void> {
  const { data: s } = await db.from("live_sessions").select("*").eq("id", sessionId).maybeSingle();
  if (!s) return;
  const session = s as LiveSession;

  // Previous session for the same brand (KPI-vs-previous), by start day.
  let previous: LiveSession | null = null;
  if (session.brand_id) {
    const { data: prevRows } = await db
      .from("live_sessions")
      .select("*")
      .eq("brand_id", session.brand_id)
      .neq("id", sessionId)
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(20);
    const list = ((prevRows ?? []) as LiveSession[]).filter(
      (r) => (r.started_at ?? r.created_at) < (session.started_at ?? session.created_at)
    );
    previous = list[0] ?? null;
  }

  const { data: bns } = await db.from("live_bottlenecks").select("*").eq("session_id", sessionId);
  const bottlenecks = (bns ?? []) as LiveBottleneck[];

  const [{ data: brand }, anchorRes, modRes] = await Promise.all([
    session.brand_id
      ? db.from("brands").select("name").eq("id", session.brand_id).maybeSingle()
      : Promise.resolve({ data: null }),
    session.anchor_id
      ? db.from("anchors").select("name").eq("id", session.anchor_id).maybeSingle()
      : Promise.resolve({ data: null }),
    Promise.resolve({ data: null }),
  ]);
  void modRes;

  const ctx: LiveBriefContext = {
    session,
    previous,
    bottlenecks,
    brandName: (brand as { name?: string } | null)?.name ?? null,
    anchorName: (anchorRes.data as { name?: string } | null)?.name ?? null,
  };

  const model = TIER_MODEL[defaultTierFor(profile.role)];
  const payload = await generateLiveBrief(ctx, { model });

  const day = manilaDateOf(session.started_at) ?? manilaDateOf(session.created_at) ?? new Date().toISOString().slice(0, 10);
  await db.from("account_review_briefs").insert({
    org_id: profile.org_id,
    department: "Live Operations",
    brand_id: session.brand_id,
    period_start: day,
    period_end: day,
    summary: payload.executive_summary,
    payload: {
      ...payload,
      scope: {
        department: "Live Operations",
        brand_name: ctx.brandName,
        session_id: sessionId,
        session_title: session.title,
        period_start: day,
        period_end: day,
      },
    },
    generated_by: profile.id,
  });
}

// ── Route ONE recommendation to a PENDING action_request (leadership) ─────────
// Money never auto-moves: this only STAGES a pending request for a human to
// approve, and there is no executor for source_module 'account_review', so even
// on approval nothing is spent or contacted (D-005). Reuses the exact draft
// builder + spine the Account Review "Send to approval" uses.
export async function routeRecommendation(formData: FormData) {
  const profile = await getSessionProfile();
  if (!profile || !["ceo", "coo", "department_head"].includes(profile.role)) return;
  const briefId = String(formData.get("brief_id") ?? "");
  const index = Number(formData.get("recommendation_index"));
  const sessionId = String(formData.get("session_id") ?? "");
  if (!briefId || !Number.isInteger(index) || index < 0) return;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const { data: briefRow } = await db
    .from("account_review_briefs")
    .select("id, department, brand_id, period_start, period_end, payload")
    .eq("id", briefId)
    .maybeSingle();
  if (!briefRow) return;
  const row = briefRow as {
    id: string;
    department: string;
    period_start: string;
    period_end: string;
    payload: BriefPayload & { scope?: { brand_name?: string | null } };
  };
  const rec = row.payload?.recommendations?.[index];
  if (!rec) return;

  // Don't stack a duplicate for the same brief + recommendation.
  const { data: existing } = await db
    .from("action_requests")
    .select("id, source_ref, status")
    .eq("source_module", "account_review")
    .in("status", ["pending", "approved"]);
  const dup = ((existing ?? []) as Array<{ id: string; source_ref: Record<string, unknown> | null }>).find(
    (r) => r.source_ref?.brief_id === briefId && Number(r.source_ref?.recommendation_index) === index
  );
  if (dup) {
    revalidatePath(`/live-ops/reports/${sessionId}`);
    return;
  }

  const draft = buildRecommendationDraft({
    brief_id: row.id,
    brief: row.payload,
    recommendation: rec,
    index,
    department: row.department,
    brand_name: row.payload?.scope?.brand_name ?? null,
    period_start: row.period_start,
    period_end: row.period_end,
  });

  const { data: created } = await db
    .from("action_requests")
    .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
    .select("id, title")
    .single();

  const ar = created as { id: string; title: string } | null;
  if (ar) {
    await writeActionAudit(db, {
      org_id: profile.org_id,
      action_request_id: ar.id,
      event: "created",
      actor_id: profile.id,
      actor_role: profile.role,
      detail: { source: "live_ops_brief", brief_id: briefId, recommendation_index: index, title: ar.title },
    });
  }
  revalidatePath(`/live-ops/reports/${sessionId}`);
  revalidatePath("/approvals");
}

// ── Schedule: update / substitute anchor for a scheduled session ──────────────
export async function updateSchedule(formData: FormData) {
  await requireRole([...MANAGE_ROLES]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("live_sessions")
    .update({
      anchor_id: optText(formData, "anchor_id"),
      moderator_id: optText(formData, "moderator_id"),
      team_leader_id: optText(formData, "team_leader_id"),
      studio: optText(formData, "studio"),
      shift: optText(formData, "shift"),
      started_at: optTimestamp(formData, "started_at"),
      expected_duration_minutes: optNum(formData, "expected_duration_minutes", true),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/live-ops/schedule");
  revalidatePath("/live-ops");
}
