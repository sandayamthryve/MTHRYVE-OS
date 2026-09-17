// lib/automation/approval-sweep.ts — the daily Approval Sweep's pure logic.
//
// Completes the documented Approval Routing agent's missing half (AI_AGENTS.md
// Agent 3): after routing + notification (already live via notifyPendingApproval),
// the sweep (a) ESCALATES requests that have sat pending past the threshold and
// (b) REPORTS THE OUTCOME back to the requester automatically.
//
// Pure and DB-free on purpose: the route owns the queries, these functions own
// the decisions — which rows escalate, which get an outcome report, and how each
// outcome is labelled. Kept side-effect-free so they're unit-testable without a
// database.

// A minimal shape of an action_requests row the sweep needs. Structural so both
// the real row and test fixtures satisfy it.
export interface SweepRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
  created_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

// ── Escalation ────────────────────────────────────────────────────────────────
// Anything still AWAITING A DECISION past `hours` age escalates. That includes
// the governed chain states ('pending_coo' / 'pending_ceo') — they are pending
// on a human too, just a specific one. Terminal states never escalate.

export const PENDING_STATES = new Set(["pending", "pending_coo", "pending_ceo"]);

export function escalationCandidates<T extends SweepRow>(
  rows: T[],
  now: Date,
  hours: number
): Array<T & { ageHours: number }> {
  if (!(hours > 0)) return [];
  const cutoff = now.getTime() - hours * 3600_000;
  return rows
    .filter(
      (r) =>
        PENDING_STATES.has(r.status) &&
        new Date(r.created_at).getTime() <= cutoff
    )
    .map((r) => ({
      ...r,
      ageHours: Math.floor((now.getTime() - new Date(r.created_at).getTime()) / 3600_000),
    }));
}

// ── Outcome report-back ───────────────────────────────────────────────────────
// Requests that REACHED A TERMINAL DECISION within the window get their filer
// told — unless the filer decided it themselves (you don't need to be told what
// you did). 'expired' / 'cancelled' count: silence about those is exactly the
// black hole this loop exists to close.

export type OutcomeKind =
  | "approved" // human approved; execution still owed
  | "executed"
  | "failed" // approved but execution FAILED — the requester must know
  | "rejected"
  | "expired"
  | "cancelled";

const OUTCOME_STATUSES = new Set<string>([
  "approved",
  "executed",
  "failed",
  "rejected",
  "expired",
  "cancelled"]);

// Terminal statuses, as a plain list for DB `in(...)` filters (single source of
// truth with the Set above).
export const OUTCOME_STATUS_LIST: string[] = [...OUTCOME_STATUSES];

export function outcomeCandidates<T extends SweepRow>(
  rows: T[],
  sinceIso: string
): Array<{ row: T; kind: OutcomeKind }> {
  const since = new Date(sinceIso).getTime();
  const out: Array<{ row: T; kind: OutcomeKind }> = [];
  for (const r of rows) {
    if (!OUTCOME_STATUSES.has(r.status)) continue;
    // A terminal state reached before the window must not re-report. Rows whose
    // decision timestamp is missing can't be placed in the window — skip rather
    // than guess (the OS never fabricates).
    if (!r.decided_at || new Date(r.decided_at).getTime() < since) continue;
    // Self-decided requests: the filer WAS the decider.
    if (r.created_by && r.decided_by && r.created_by === r.decided_by) continue;
    out.push({ row: r, kind: r.status as OutcomeKind });
  }
  return out;
}

export const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  approved: "approved",
  executed: "approved & executed",
  failed: "approved but execution FAILED",
  rejected: "rejected",
  expired: "expired",
  cancelled: "cancelled",
};

export function outcomeSeverity(kind: OutcomeKind): "info" | "warning" | "critical" {
  switch (kind) {
    case "failed":
      return "critical";
    case "rejected":
      return "warning";
    default:
      return "info";
  }
}
