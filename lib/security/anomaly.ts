// lib/security/anomaly.ts — the anomaly monitor (PASTE 4.3 Part D).
//
// SERVER-ONLY, deterministic, READ-ONLY over the signal tables. It compares a
// RECENT window (default last 60 min) against a rolling BASELINE (prior 7 days)
// for one org and flags:
//   • spend spikes        — sum(ai_usage_log.est_cost_php)
//   • mass data reads      — count(ai_usage_log) calls in the window
//   • failed-login bursts  — count(security_events: failed_login)
//   • RLS-denial surges    — count(security_events: rls_denial)
//   • unusual export volume— count(security_events: data_export)
//
// A flagged anomaly is UPSERT-deduped into public.security_anomalies (one row per
// org+kind+window) and, when newly raised, NOTIFIES leadership (Telegram, the
// OS's existing channel) with a one-line summary and the incident-runbook link.
// Nothing here executes or blocks anything — it observes and alerts, exactly like
// the Automation Radar detector it mirrors. Runs under the service-role client
// (org-wide, no request context), so every read is scoped by an explicit org_id.

import { sendTelegram, escapeHtml } from "@/lib/telegram";

type Shim = { from: (t: string) => any };

// ── Tunables (env-overridable so leadership/ops can tighten without a deploy) ──
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const RECENT_MINUTES = () => envNum("ANOMALY_WINDOW_MINUTES", 60);
const BASELINE_DAYS = () => envNum("ANOMALY_BASELINE_DAYS", 7);
const SPIKE_FACTOR = () => envNum("ANOMALY_SPIKE_FACTOR", 3); // "N× the norm"
// Absolute floors so a quiet baseline doesn't fire on trivial activity.
const SPEND_FLOOR_PHP = () => envNum("ANOMALY_SPEND_FLOOR_PHP", 500);
const MASS_READ_FLOOR = () => envNum("ANOMALY_MASS_READ_FLOOR", 120);
const FAILED_LOGIN_FLOOR = () => envNum("ANOMALY_FAILED_LOGIN_FLOOR", 5);
const RLS_DENIAL_FLOOR = () => envNum("ANOMALY_RLS_DENIAL_FLOOR", 10);
const EXPORT_FLOOR = () => envNum("ANOMALY_EXPORT_FLOOR", 20);

// The incident runbook the alert links to.
export function runbookUrl(): string {
  return (
    process.env.INCIDENT_RUNBOOK_URL?.trim() ||
    "https://github.com/albertjhonmorales-spec/mthryve-os-private/blob/main/docs/INCIDENT_RUNBOOK.md"
  );
}

export type AnomalyKind =
  | "spend_spike"
  | "mass_data_reads"
  | "failed_login_burst"
  | "rls_denial_surge"
  | "unusual_export_volume";

export interface Anomaly {
  kind: AnomalyKind;
  severity: "warning" | "critical";
  metricValue: number;
  threshold: number;
  baseline: number;
  detail: Record<string, unknown>;
}

// ── Pure evaluators (unit-testable; no I/O) ──────────────────────────────────

/**
 * Decide whether a measured value is a spike. Fires when it clears BOTH an
 * absolute floor (so a quiet baseline can't trip on noise) AND `factor`× the
 * baseline expectation. Returns the effective threshold used.
 */
export function evaluateSpike(
  value: number,
  baselineExpected: number,
  factor: number,
  floor: number
): { flag: boolean; threshold: number } {
  const threshold = Math.max(floor, baselineExpected * factor);
  return { flag: value >= floor && value > threshold, threshold };
}

function severityFor(value: number, threshold: number): "warning" | "critical" {
  return value >= threshold * 2 ? "critical" : "warning";
}

// ── Row shapes read from the signal tables ───────────────────────────────────
type UsageRow = { created_at: string | null; est_cost_php: number | null; user_id: string | null };
type EventRow = { created_at: string | null; event_type: string | null; user_id: string | null };

interface Windows {
  now: Date;
  recentStart: Date;
  baselineStart: Date;
}

function windows(now: Date): Windows {
  const recentStart = new Date(now.getTime() - RECENT_MINUTES() * 60_000);
  const baselineStart = new Date(now.getTime() - BASELINE_DAYS() * 24 * 60 * 60_000);
  return { now, recentStart, baselineStart };
}

// How many recent-length windows fit in the baseline span (for a per-window avg).
function baselineWindowCount(w: Windows): number {
  const baselineMs = w.recentStart.getTime() - w.baselineStart.getTime();
  const windowMs = RECENT_MINUTES() * 60_000;
  return Math.max(1, baselineMs / windowMs);
}

function inRecent(ts: string | null, w: Windows): boolean {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return t >= w.recentStart.getTime() && t <= w.now.getTime();
}

function inBaseline(ts: string | null, w: Windows): boolean {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return t >= w.baselineStart.getTime() && t < w.recentStart.getTime();
}

export interface OrgScanSummary {
  org_id: string;
  anomalies: Anomaly[];
  raised: number; // newly-inserted (and notified) this run
}

// Detect anomalies for ONE org, upsert-dedupe them, and notify on newly raised
// ones. `now` is injectable for testing. Returns a small summary.
export async function detectForOrg(db: Shim, orgId: string, now: Date = new Date()): Promise<OrgScanSummary> {
  const w = windows(now);
  const baselineStartIso = w.baselineStart.toISOString();

  const [usageRes, eventRes] = await Promise.all([
    db
      .from("ai_usage_log")
      .select("created_at, est_cost_php, user_id")
      .eq("org_id", orgId)
      .gte("created_at", baselineStartIso),
    db
      .from("security_events")
      .select("created_at, event_type, user_id")
      .eq("org_id", orgId)
      .gte("created_at", baselineStartIso),
  ]);

  const usage = (usageRes?.data ?? []) as UsageRow[];
  const events = (eventRes?.data ?? []) as EventRow[];

  const nWindows = baselineWindowCount(w);
  const anomalies: Anomaly[] = [];

  // 1) Spend spike — sum of estimated ₱ in the recent window vs per-window avg.
  {
    const recent = usage.filter((r) => inRecent(r.created_at, w)).reduce((a, r) => a + Number(r.est_cost_php ?? 0), 0);
    const baselineTotal = usage.filter((r) => inBaseline(r.created_at, w)).reduce((a, r) => a + Number(r.est_cost_php ?? 0), 0);
    const expected = baselineTotal / nWindows;
    const { flag, threshold } = evaluateSpike(recent, expected, SPIKE_FACTOR(), SPEND_FLOOR_PHP());
    if (flag) {
      anomalies.push({
        kind: "spend_spike",
        severity: severityFor(recent, threshold),
        metricValue: Math.round(recent * 100) / 100,
        threshold: Math.round(threshold * 100) / 100,
        baseline: Math.round(expected * 100) / 100,
        detail: { currency: "PHP", window_minutes: RECENT_MINUTES(), recent_calls: usage.filter((r) => inRecent(r.created_at, w)).length },
      });
    }
  }

  // 2) Mass data reads — count of AI calls (each reads data) in the recent window.
  {
    const recentRows = usage.filter((r) => inRecent(r.created_at, w));
    const recent = recentRows.length;
    const expected = usage.filter((r) => inBaseline(r.created_at, w)).length / nWindows;
    const { flag, threshold } = evaluateSpike(recent, expected, SPIKE_FACTOR(), MASS_READ_FLOOR());
    if (flag) {
      anomalies.push({
        kind: "mass_data_reads",
        severity: severityFor(recent, threshold),
        metricValue: recent,
        threshold: Math.round(threshold),
        baseline: Math.round(expected * 100) / 100,
        detail: { window_minutes: RECENT_MINUTES(), distinct_users: new Set(recentRows.map((r) => r.user_id)).size, top_user: topActor(recentRows.map((r) => r.user_id)) },
      });
    }
  }

  // 3-5) Security-event surges (failed login / RLS denial / export volume).
  const eventChecks: Array<{ kind: AnomalyKind; type: string; floor: number }> = [
    { kind: "failed_login_burst", type: "failed_login", floor: FAILED_LOGIN_FLOOR() },
    { kind: "rls_denial_surge", type: "rls_denial", floor: RLS_DENIAL_FLOOR() },
    { kind: "unusual_export_volume", type: "data_export", floor: EXPORT_FLOOR() },
  ];
  for (const check of eventChecks) {
    const ofType = events.filter((e) => e.event_type === check.type);
    const recentRows = ofType.filter((e) => inRecent(e.created_at, w));
    const recent = recentRows.length;
    const expected = ofType.filter((e) => inBaseline(e.created_at, w)).length / nWindows;
    const { flag, threshold } = evaluateSpike(recent, expected, SPIKE_FACTOR(), check.floor);
    if (flag) {
      anomalies.push({
        kind: check.kind,
        severity: severityFor(recent, threshold),
        metricValue: recent,
        threshold: Math.round(threshold),
        baseline: Math.round(expected * 100) / 100,
        detail: { window_minutes: RECENT_MINUTES(), distinct_users: new Set(recentRows.map((e) => e.user_id)).size, top_user: topActor(recentRows.map((e) => e.user_id)) },
      });
    }
  }

  // Persist + notify newly-raised anomalies (dedupe per org+kind+window).
  let raised = 0;
  const windowStartIso = w.recentStart.toISOString();
  const windowEndIso = w.now.toISOString();
  for (const a of anomalies) {
    const isNew = await upsertAnomaly(db, orgId, a, windowStartIso, windowEndIso);
    if (isNew) {
      raised++;
      await notifyLeadership(db, orgId, a, windowEndIso);
    }
  }

  return { org_id: orgId, anomalies, raised };
}

function topActor(ids: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const id of ids) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) if (n > bestN) ((best = id), (bestN = n));
  return best;
}

// Insert the anomaly if this org+kind+window isn't already recorded. Returns true
// when a NEW row was created (so the caller notifies exactly once per window).
async function upsertAnomaly(
  db: Shim,
  orgId: string,
  a: Anomaly,
  windowStartIso: string,
  windowEndIso: string
): Promise<boolean> {
  try {
    const { data: existing } = await db
      .from("security_anomalies")
      .select("id")
      .eq("org_id", orgId)
      .eq("kind", a.kind)
      .eq("window_start", windowStartIso)
      .maybeSingle();
    if (existing) return false;

    const { error } = await db.from("security_anomalies").insert({
      org_id: orgId,
      kind: a.kind,
      severity: a.severity,
      metric_value: a.metricValue,
      threshold: a.threshold,
      baseline: a.baseline,
      window_start: windowStartIso,
      window_end: windowEndIso,
      detail: a.detail,
      runbook_url: runbookUrl(),
      status: "open",
      notified_at: new Date().toISOString(),
    });
    return !error;
  } catch {
    return false;
  }
}

const KIND_LABEL: Record<AnomalyKind, string> = {
  spend_spike: "AI spend spike",
  mass_data_reads: "Mass data reads",
  failed_login_burst: "Failed-login burst",
  rls_denial_surge: "RLS-denial surge",
  unusual_export_volume: "Unusual export volume",
};

// Notify leadership through the OS's existing Telegram channel (best-effort). The
// message carries the metric, the threshold it cleared, and the runbook link.
async function notifyLeadership(db: Shim, orgId: string, a: Anomaly, when: string): Promise<void> {
  const unit = a.kind === "spend_spike" ? "₱" : "";
  const icon = a.severity === "critical" ? "🚨" : "⚠️";
  const lines = [
    `${icon} <b>Security anomaly — ${escapeHtml(KIND_LABEL[a.kind])}</b>`,
    `Severity: ${a.severity.toUpperCase()}`,
    `Measured: ${unit}${a.metricValue} (threshold ${unit}${a.threshold}, baseline ${unit}${a.baseline})`,
    `Window ending: ${escapeHtml(when)}`,
    `Runbook: ${escapeHtml(runbookUrl())}`,
  ];
  await sendTelegram(lines.join("\n"));
}

// Run the monitor across every org (the ONE engine, org-wide). Service-role.
export async function runAnomalyScan(db: Shim, now: Date = new Date()): Promise<OrgScanSummary[]> {
  const { data } = await db.from("organizations").select("id");
  const orgs = ((data ?? []) as Array<{ id: string }>).map((o) => o.id);
  const summaries: OrgScanSummary[] = [];
  for (const orgId of orgs) {
    try {
      summaries.push(await detectForOrg(db, orgId, now));
    } catch {
      summaries.push({ org_id: orgId, anomalies: [], raised: 0 });
    }
  }
  return summaries;
}
