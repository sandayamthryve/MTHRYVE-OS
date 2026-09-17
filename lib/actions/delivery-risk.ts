// lib/actions/delivery-risk.ts — the first proactive loop's SIGNAL PRODUCER.
//
// It reads the SAME Reports-vs-Contract attainment the board shows (nothing is
// recomputed differently) and, for each measurable scope item that is genuinely
// pacing to miss its committed target, drafts ONE action_request carrying Tony's
// full reasoning. It never executes and never fabricates: an item with no target
// or no data is skipped, not flagged, so the queue only ever shows real risk.
//
// The at-risk rule (v1): attainment < 70% AND the contract window is > 60%
// elapsed. Both sides are guarded — attainmentPct/expectedPct are null unless a
// real target and real data exist, and a null on either side means "not at risk"
// (honest, no false alarms).

import type { ContractRow, ScopeAttainment } from "@/lib/metrics/contracts";
import { todayManila } from "@/lib/metrics/windows";
import { peso, int } from "@/lib/metrics/format";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "./types";

// Thresholds — one place so the UI copy and the predicate can never drift.
export const AT_RISK_ATTAINMENT_PCT = 70;
export const MIN_WINDOW_ELAPSED_PCT = 60;

// The measurable deliverable types this loop scans. 'ads'/'other' are excluded
// per spec — ads track a budget (spending "behind" isn't a delivery risk) and
// 'other' is manual.
export const SCANNED_TYPES = ["gmv", "content", "live"] as const;

// True only when we can honestly grade the item AND it is pacing to miss:
// behind on attainment while most of the window has already elapsed.
export function isAtRisk(sa: ScopeAttainment): boolean {
  const a = sa.attainment;
  if (a.attainmentPct == null || a.expectedPct == null) return false; // no target / no data
  return a.attainmentPct < AT_RISK_ATTAINMENT_PCT && a.expectedPct > MIN_WINDOW_ELAPSED_PCT;
}

// Whole days remaining in the contract window as of `today` (Manila), floored at
// 0. Null when the window has no end date to count toward.
export function daysLeft(periodEnd: string | null, today: string = todayManila()): number | null {
  if (!periodEnd) return null;
  const e = Date.parse(`${periodEnd}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(e) || !Number.isFinite(t)) return null;
  return Math.max(0, Math.round((e - t) / 86_400_000));
}

// The full drafted payload for one at-risk item, minus org_id (the caller stamps
// that from the profile so the RLS with_check passes). This is Tony's reasoning
// as it lands in the queue.
export interface DeliveryRiskDraft {
  source_module: "reports_vs_contract";
  source_ref: {
    contract_id: string;
    scope_item_id: string;
    brand_id: string | null;
    department_id: string | null;
  };
  title: string;
  problem: string;
  root_cause: string;
  evidence: EvidenceFact[];
  options: ActionOption[];
  recommendation: string;
  estimated_impact: EstimatedImpact;
  confidence: number;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: ProposedAction;
}

// Format a target/actual honouring money vs count vs hours (mirrors the board's
// formatValue, kept local so this module has no UI dependency).
function fmtValue(v: number | null, isMoney: boolean, unit: string | null): string {
  if (v == null) return "—";
  if (isMoney) return peso(Number(v));
  const u = (unit ?? "").toLowerCase();
  if (u.includes("hour") || u.includes("hr")) return `${Math.round(Number(v) * 10) / 10}h`;
  return int(Number(v));
}

// A defensible confidence in the *diagnosis* (that this item is at risk): the
// further behind pace and the more of the window elapsed, the more certain the
// signal. Bounded to [0.5, 0.95] — Tony is never presented as certain.
function diagnosisConfidence(attainmentPct: number, expectedPct: number): number {
  const behindBy = Math.max(0, expectedPct - attainmentPct); // points below pace
  const raw = 0.5 + behindBy / 200 + (expectedPct - MIN_WINDOW_ELAPSED_PCT) / 200;
  return Math.min(0.95, Math.max(0.5, Math.round(raw * 100) / 100));
}

// Build the draft for one at-risk scope item. Caller guarantees isAtRisk(sa).
export function buildDeliveryRiskDraft(
  sa: ScopeAttainment,
  contract: ContractRow,
  brandName: string | null,
  today: string = todayManila()
): DeliveryRiskDraft {
  const { item, attainment: a } = sa;
  const attain = Math.round(a.attainmentPct ?? 0);
  const elapsed = a.expectedPct ?? 0;
  const left = daysLeft(contract.period_end, today);
  const client = contract.client_name ?? "the client";
  const who = brandName ? `${brandName} (${client})` : client;
  const unitLabel = a.unit ?? a.deliverableType;

  const gap =
    a.target != null && a.actual != null ? Math.max(0, Number(a.target) - Number(a.actual)) : null;

  const problem =
    `${item.title} for ${who} is at ${attain}% of its committed ${unitLabel} target` +
    `${left != null ? ` with ${left} day${left === 1 ? "" : "s"} left in the contract window` : ""}.`;

  const root_cause =
    `Delivery is trailing the contract pace — ${attain}% delivered against ${elapsed}% of the ` +
    `window elapsed. At the current rate the deliverable is not on track to hit target by period end.`;

  const evidence: EvidenceFact[] = [
    { label: "Attainment", value: `${attain}%` },
    { label: "Actual delivered", value: fmtValue(a.actual, a.isMoney, a.unit) },
    { label: "Committed target", value: fmtValue(a.target, a.isMoney, a.unit) },
    { label: "Window elapsed", value: `${elapsed}%` },
  ];
  if (left != null) evidence.push({ label: "Days left", value: String(left) });

  const options: ActionOption[] = [
    {
      label: "Spin up a recovery project in the owning department",
      tradeoff:
        "Focuses the department on closing the gap now, with an owner and a due date — but adds to their active load.",
    },
    {
      label: "Reassign or add capacity to this deliverable",
      tradeoff:
        "Can lift output faster, but pulls people off other clients and needs a manual staffing call.",
    },
    {
      label: "Renegotiate or adjust the committed target",
      tradeoff:
        "Removes the shortfall on paper and resets expectations, but is a client conversation, not an internal fix.",
    },
  ];

  const impactSummary =
    gap != null
      ? `Closing a ${fmtValue(gap, a.isMoney, a.unit)} gap keeps ${who} on contract.`
      : `Gets ${item.title} for ${who} back on pace before period end.`;

  return {
    source_module: "reports_vs_contract",
    source_ref: {
      contract_id: contract.id,
      scope_item_id: item.id,
      brand_id: item.brand_id,
      department_id: item.department_id,
    },
    title: `Recovery: ${item.title} — ${who}`,
    problem,
    root_cause,
    evidence,
    options,
    recommendation:
      "Spin up a recovery project in the owning department, owned by its head and due at contract period end, to close the gap.",
    estimated_impact: {
      summary: impactSummary,
      gap_value: gap,
      gap_unit: a.unit ?? a.deliverableType,
      is_money: a.isMoney,
    },
    confidence: diagnosisConfidence(attain, elapsed),
    risk_tier: 3,
    required_role: "coo",
    proposed_action: {
      type: "create_recovery_project",
      payload: {
        scope_item_id: item.id,
        department_id: item.department_id,
        brand_id: item.brand_id,
        title: `Recovery: ${item.title} — ${who}`,
      },
    },
  };
}
