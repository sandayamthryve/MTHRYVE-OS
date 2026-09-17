// lib/tiktok/health.ts — the TikTok Shop sync-health monitor.
//
// The daily read-sync can fail SILENTLY: an expired token bounces the request to
// an HTML /login page, TikTok answers 200, and the old parser turned that into a
// "success" with 0 rows. GitHub Actions saw a 200 and reported success — so a two-day
// outage went unseen. This monitor is the OS's own watchdog: it reads the
// run-level classification the sync now records and TELLS leadership when the
// sync truly failed, stalled, or is about to (a token expiring within 48h).
//
// Three incident kinds (see lib/notifications/producers.notifySyncHealthAlert):
//   • missing — no run summary on record, or the last one is older than the SLA
//               (STALE_RUN_HOURS). The daily schedule likely stopped firing.
//   • failed  — the last run classified as failed / auth_failed (0 rows landed).
//   • token   — an active connection's access token expires within 48h. A
//               warning, fired BEFORE it lapses so leadership can reconnect.
//
// Every alert is best-effort and idempotent to ONE per (incident, day) — the
// producer guards on the incident key, so a daily re-run re-alerts no one.
// Read-only against the OS: this never touches TikTok and never mutates a sync
// row — it only reads the trail and notifies.

import { getLatestRunSummary, listSyncOrgIds, type LatestRunSummary } from "@/lib/tiktok/sync";
import { listExpiringConnections } from "@/lib/tiktok/vault";
import { notifySyncHealthAlert, type SyncIncidentKind } from "@/lib/notifications/producers";
import { writeAudit } from "@/lib/audit/log";
import { todayManila } from "@/lib/metrics/windows";

// A scheduled run older than this (hours) is treated as MISSING. The sync runs
// daily; 26h gives the schedule a 2h grace window past a 24h cadence.
export const STALE_RUN_HOURS = 26;
// Warn when an access token expires within this window (hours) — before it
// lapses and the next sync bounces to /login.
export const TOKEN_EXPIRY_WARN_HOURS = 48;

// Run-summary statuses that mean "the sync truly failed" (see classifyRun).
const FAILED_STATUSES = new Set(["failed", "auth_failed"]);

// A run-level incident the monitor detected for one org. Pure, so it can be
// unit-tested without a database.
export interface RunIncident {
  kind: Extract<SyncIncidentKind, "missing" | "failed">;
  reason: string; // short, PII-free, for the audit trail + logs
  title: string;
  body: string;
}

// Decide whether an org's latest run summary is an incident. Pure: `nowMs` is
// passed in so the thresholds are deterministic under test.
export function classifyRunHealth(
  last: LatestRunSummary | null,
  nowMs: number
): RunIncident | null {
  if (!last) {
    return {
      kind: "missing",
      reason: "no run summary on record",
      title: "TikTok sync never ran",
      body:
        "No completed TikTok Shop sync is on record. The daily read-sync may " +
        "never have run — check the GitHub Actions schedule that drives it.",
    };
  }
  const finished = last.finished_at ?? last.started_at;
  const ageHours = (nowMs - new Date(finished).getTime()) / 3600_000;
  if (!Number.isFinite(ageHours) || ageHours > STALE_RUN_HOURS) {
    const ageLabel = Number.isFinite(ageHours) ? `~${Math.round(ageHours)}h ago` : "unknown";
    return {
      kind: "missing",
      reason: `last run ${ageLabel} (SLA ${STALE_RUN_HOURS}h)`,
      title: "TikTok sync is stale",
      body:
        `The last TikTok Shop sync completed ${ageLabel} (SLA ${STALE_RUN_HOURS}h). ` +
        "The daily schedule may have stopped firing — check the GitHub Actions workflow.",
    };
  }
  if (FAILED_STATUSES.has(last.status)) {
    return {
      kind: "failed",
      reason: `last run status=${last.status}`,
      title: "TikTok sync failed",
      body:
        `The last TikTok Shop sync classified as "${last.status}" — it landed no ` +
        "data (most often an expired token bouncing to /login). Reconnect in " +
        "Settings and re-run the sync.",
    };
  }
  return null;
}

export interface SyncHealthSummary {
  ok: true;
  orgs: number; // orgs with at least one active shop
  alerts: number; // alerts actually sent this run (bell + Telegram)
  deduped: number; // incidents skipped because one already went out today
  tokenWarnings: number; // token-expiry warnings among the alerts
  incidents: Array<{ orgId: string; kind: SyncIncidentKind; reason: string; sent: boolean }>;
}

// The monitor's one entry point: evaluate every syncing org's run health and
// every connection's token expiry, and fire an idempotent alert per incident.
// Returns a summary the route echoes back (and the schedule can log).
export async function runSyncHealthCheck(nowMs: number = Date.now()): Promise<SyncHealthSummary> {
  const today = todayManila(nowMs);
  const orgIds = await listSyncOrgIds();

  const summary: SyncHealthSummary = {
    ok: true,
    orgs: orgIds.length,
    alerts: 0,
    deduped: 0,
    tokenWarnings: 0,
    incidents: [],
  };

  // 1) Per-org run health (missing / stale / failed).
  for (const orgId of orgIds) {
    const last = await getLatestRunSummary(orgId);
    const incident = classifyRunHealth(last, nowMs);
    if (!incident) continue;

    const incidentId = `sync:${orgId}:${incident.kind}:${today}`;
    const res = await notifySyncHealthAlert({
      orgId,
      kind: incident.kind,
      incidentId,
      title: incident.title,
      body: incident.body,
    });
    summary.incidents.push({ orgId, kind: incident.kind, reason: incident.reason, sent: res.sent });
    if (res.sent) {
      summary.alerts += 1;
      await writeAudit({
        orgId,
        action: "sync_health_alert",
        entityType: "tiktok_sync",
        entityId: incidentId,
        detail: { source: "health-check", incident: incident.kind, reason: incident.reason },
      });
    } else if (res.deduped) {
      summary.deduped += 1;
    }
  }

  // 2) Token expiry (<48h) — one warning per connection per day.
  const expiring = await listExpiringConnections(TOKEN_EXPIRY_WARN_HOURS);
  for (const conn of expiring) {
    const expMs = new Date(conn.access_token_expires_at).getTime();
    const hours = Math.round((expMs - nowMs) / 3600_000);
    const seller = conn.seller_name ? ` (${conn.seller_name})` : "";
    const lapsed = !Number.isFinite(hours) || hours <= 0;
    const when = lapsed ? "has expired" : `expires in ~${hours}h`;

    const incidentId = `sync:${conn.org_id}:token:${conn.open_id}:${today}`;
    const res = await notifySyncHealthAlert({
      orgId: conn.org_id,
      kind: "token",
      incidentId,
      title: `TikTok token ${lapsed ? "expired" : "expiring"}${seller}`,
      body:
        `The TikTok Shop access token${seller} ${when}. Reconnect in Settings ` +
        "before the daily sync bounces to /login.",
    });
    summary.incidents.push({ orgId: conn.org_id, kind: "token", reason: `token ${when}`, sent: res.sent });
    if (res.sent) {
      summary.alerts += 1;
      summary.tokenWarnings += 1;
      await writeAudit({
        orgId: conn.org_id,
        action: "sync_health_alert",
        entityType: "tiktok_sync",
        entityId: incidentId,
        detail: { source: "health-check", incident: "token", reason: `token ${when}` },
      });
    } else if (res.deduped) {
      summary.deduped += 1;
    }
  }

  return summary;
}
