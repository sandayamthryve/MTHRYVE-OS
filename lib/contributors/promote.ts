// lib/contributors/promote.ts — the "Approve work-data → live_sessions" promotion.
//
// A contributor_log carries a host's snapped Live-Ops numbers (viewers / gmv /
// ctor) as an UNVERIFIED reading plus its evidence photo. Nothing touches the
// live metric store until a moderator approves it. On approval this helper
// PROMOTES the log: it upserts ONE live_sessions row for that brand + date + host
// and records the resulting session id back on the log (promoted_session_id), so
// re-approving is idempotent and never spawns duplicate sessions.
//
// It writes with the SERVICE-ROLE client on purpose: promotion is a trusted,
// already-authorized server step (the caller re-checks the moderator's rights
// first), and this keeps the write off the live_sessions page entirely — the
// promotion is a NEW server action, never an edit to that cluster surface.
//
// One home per fact: the snapped numbers land in live_sessions ONLY (source
// 'manual'), the same store the Live Ops dashboards already aggregate. Nothing is
// re-encoded into metric_entries.

type Db = { from: (t: string) => any };

// The whitelisted Live-Ops keys a snap can carry → their live_sessions columns.
// viewers/ctor stay numeric; gmv is money. Anything else on the log's
// extracted_metrics is ignored (the whitelist already bounds it upstream).
function metricsFromLog(
  extracted: Record<string, unknown> | null | undefined
): { viewers: number | null; gmv: number | null; ctor: number | null } {
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const m = extracted ?? {};
  return {
    viewers: num((m as Record<string, unknown>).viewers),
    gmv: num((m as Record<string, unknown>).gmv),
    ctor: num((m as Record<string, unknown>).ctor),
  };
}

export interface PromotableLog {
  id: string;
  org_id: string;
  brand_id: string | null;
  log_date: string;
  clock_in_at: string | null;
  extracted_metrics: Record<string, unknown> | null;
  promoted_session_id: string | null;
}

export interface PromotionContributor {
  id: string;
  name: string;
  platform: string | null;
}

// Upsert the live_sessions row for a contributor log and return its id. `db` MUST
// be a service-role client. `moderatorId` is the approving user (stored as
// created_by / moderator_id). Idempotent: keyed first on the log's existing
// promoted_session_id, then on a stable external_id derived from the log id.
export async function promoteLogToLiveSession(
  db: Db,
  log: PromotableLog,
  contributor: PromotionContributor,
  moderatorId: string
): Promise<string | null> {
  const metrics = metricsFromLog(log.extracted_metrics);
  const externalId = `contributor_log:${log.id}`;

  // started_at: the host's clock-in if present, else Manila noon of the log date
  // (a stable, in-day timestamp so the session sorts on the right day).
  const startedAt = log.clock_in_at ?? new Date(`${log.log_date}T12:00:00+08:00`).toISOString();

  const payload: Record<string, unknown> = {
    org_id: log.org_id,
    brand_id: log.brand_id,
    platform: contributor.platform || "tiktok_shop",
    source: "manual",
    status: "ended",
    started_at: startedAt,
    title: `${contributor.name} · ${log.log_date}`,
    external_id: externalId,
    viewers: metrics.viewers,
    gmv: metrics.gmv,
    ctor: metrics.ctor,
    moderator_id: moderatorId,
    notes: "Promoted from contributor live-results snap (moderator-approved).",
    updated_at: new Date().toISOString(),
  };

  // 1) Already promoted once — update that exact row.
  if (log.promoted_session_id) {
    await db.from("live_sessions").update(payload).eq("id", log.promoted_session_id);
    return log.promoted_session_id;
  }

  // 2) A row already exists for this log's external_id (e.g. a prior approval
  //    whose id wasn't written back) — update it rather than duplicating.
  const { data: existing } = await db
    .from("live_sessions")
    .select("id")
    .eq("org_id", log.org_id)
    .eq("external_id", externalId)
    .maybeSingle();
  if (existing?.id) {
    await db.from("live_sessions").update(payload).eq("id", existing.id);
    return existing.id as string;
  }

  // 3) First promotion — insert a fresh session.
  const { data: created, error } = await db
    .from("live_sessions")
    .insert({ ...payload, created_by: moderatorId })
    .select("id")
    .single();
  if (error || !created) return null;
  return created.id as string;
}
