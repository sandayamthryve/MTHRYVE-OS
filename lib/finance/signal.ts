// lib/finance/signal.ts — the Cash-Flow Deficit loop's SIGNAL PRODUCER.
//
// Given a forecast that dips below the safety buffer inside the horizon, it
// drafts ONE action_request carrying Tony's full reasoning: the projected
// deficit, the drivers behind it (balance, burn, payroll, retainers,
// settlements), the options a finance lead would weigh, a recommendation and a
// machine-executable proposed_action. It never executes and never fabricates —
// a forecast that stays cash-positive produces no draft (isForecastDeficit is
// false), so the queue only ever shows a real, dated shortfall.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, the OS
// opens a task. This module proposes a PLAN only — never a transfer. The
// proposed_action's type is 'create_cashflow_task', whose executor opens an
// internal CEO/COO task; no money ever moves.

import { peso } from "@/lib/metrics/format";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "@/lib/actions/types";
import type { CashForecast } from "./forecast";

// A forecast is actionable only when it projects a real deficit inside the
// horizon — a dated day the balance falls below the buffer. No deficit → no draft
// (honest: no false alarms).
export function isForecastDeficit(forecast: CashForecast | null | undefined): boolean {
  return !!forecast && forecast.deficitDate != null && forecast.runwayDays != null;
}

// The drafted payload for a projected deficit, minus org_id (the caller stamps
// that from the profile so the RLS with_check passes). `isoWeek` is carried in
// source_ref so the producer stays idempotent — one cash-flow draft per week.
export interface CashflowDraft {
  source_module: "finance";
  source_ref: {
    iso_week: string;
    as_of_date: string;
    deficit_date: string;
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

// A short, friendly date ("Aug 12") for prose; falls back to the raw YYYY-MM-DD.
const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function shortDate(dateStr: string): string {
  const m = Number(dateStr.slice(5, 7)) - 1;
  const d = Number(dateStr.slice(8, 10));
  return SHORT_MONTHS[m] != null ? `${SHORT_MONTHS[m]} ${d}` : dateStr;
}

function dayLabel(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

// Confidence in the DIAGNOSIS (that a deficit is coming), not a promise it will.
// The sooner the deficit lands within the horizon and the deeper the trough, the
// more certain the signal. Bounded to [0.55, 0.9] — Tony is never shown as
// certain about the future.
function deficitConfidence(forecast: CashForecast): number {
  const horizon = forecast.drivers.horizonDays || 60;
  const runway = forecast.runwayDays ?? horizon;
  const imminence = 1 - Math.min(1, runway / horizon); // 0 (far) … 1 (immediate)
  const depth = Math.min(1, Math.abs(forecast.minBalance) / Math.max(1, Math.abs(forecast.startBalance) || 1));
  const raw = 0.55 + imminence * 0.25 + depth * 0.1;
  return Math.min(0.9, Math.max(0.55, Math.round(raw * 100) / 100));
}

// The one-line action the recommendation leads with, echoed into the task.
const SUGGESTED_ACTION =
  "Accelerate receivables and defer discretionary spend ahead of the shortfall; arrange a financing buffer if the gap persists.";

// Build the draft for a deficit forecast. Caller guarantees isForecastDeficit.
export function buildCashflowDraft(forecast: CashForecast, isoWeek: string): CashflowDraft {
  const d = forecast.drivers;
  const deficitDate = forecast.deficitDate as string;
  const runway = forecast.runwayDays as number;
  const shortfall = forecast.projectedShortfall ?? Math.max(0, d.safetyBuffer - forecast.minBalance);
  const balanceOnDeficit = forecast.points.find((p) => p.date === deficitDate)?.balance ?? forecast.minBalance;

  const bufferNote = d.safetyBuffer > 0 ? ` (safety buffer ${peso(d.safetyBuffer)})` : "";

  const problem =
    `Projected cash deficit in ${dayLabel(runway)}: balance falls to ${peso(Math.round(balanceOnDeficit))} ` +
    `on ${shortDate(deficitDate)}${bufferNote}, from ${peso(Math.round(d.currentBalance))} on hand as of ${shortDate(d.asOfDate)}.`;

  const netDir = d.avgDailyNet < 0 ? "burning" : "net-positive at";
  const root_cause =
    `Cash is ${netDir} ${peso(Math.round(Math.abs(d.avgDailyNet)))}/day on average across the ${d.horizonDays}-day horizon. ` +
    (d.nextPayroll
      ? `The next payroll of ${peso(Math.round(d.nextPayroll.total))} on ${shortDate(d.nextPayroll.date)} is the largest scheduled outflow. `
      : "") +
    `Recurring inflows (retainers ${peso(Math.round(d.retainerMonthly))}/mo, settlements ${peso(
      Math.round(d.settlementRunRateDaily)
    )}/day) do not cover the expense run-rate (${peso(Math.round(d.expenseRunRateDaily))}/day) plus scheduled payroll before the shortfall date.`;

  const evidence: EvidenceFact[] = [
    { label: "Current balance", value: peso(Math.round(d.currentBalance)) },
    { label: "As of", value: shortDate(d.asOfDate) },
    { label: "Avg daily net", value: `${d.avgDailyNet < 0 ? "−" : "+"}${peso(Math.round(Math.abs(d.avgDailyNet)))}/day` },
    {
      label: "Next payroll",
      value: d.nextPayroll ? `${peso(Math.round(d.nextPayroll.total))} · ${shortDate(d.nextPayroll.date)}` : "none in horizon",
    },
    { label: "Retainer inflows", value: `${peso(Math.round(d.retainerMonthly))}/mo` },
    { label: "Expense run-rate", value: `${peso(Math.round(d.expenseRunRateDaily))}/day` },
    { label: "Settlement run-rate", value: `${peso(Math.round(d.settlementRunRateDaily))}/day` },
    { label: "Deficit date", value: shortDate(deficitDate) },
  ];

  const options: ActionOption[] = [
    {
      label: "Accelerate receivables",
      tradeoff:
        "Pulls cash in sooner (collect retainers early, chase settlements) — but leans on clients/platforms and may only shift timing, not the underlying gap.",
    },
    {
      label: "Defer discretionary spend",
      tradeoff:
        "Cuts the daily burn immediately with no external ask — but pauses initiatives and can slow growth if held too long.",
    },
    {
      label: "Arrange financing",
      tradeoff:
        "A credit line or bridge covers the trough without touching operations — but adds cost and takes lead time to secure.",
    },
    {
      label: "Trim cost",
      tradeoff:
        "Lowers the run-rate structurally and durably — but is the slowest lever and the hardest to reverse.",
    },
  ];

  const recommendation =
    `Accelerate receivables and defer discretionary spend now to clear the ${peso(Math.round(shortfall))} shortfall projected for ${shortDate(deficitDate)}; ` +
    `line up a financing buffer if the gap persists. Open a CEO/COO task to own the plan — nothing is transferred automatically.`;

  return {
    source_module: "finance",
    source_ref: { iso_week: isoWeek, as_of_date: d.asOfDate, deficit_date: deficitDate },
    title: `Cash-flow deficit projected ${shortDate(deficitDate)} — ${dayLabel(runway)} runway`,
    problem,
    root_cause,
    evidence,
    options,
    recommendation,
    estimated_impact: {
      summary: `Covering a ${peso(Math.round(shortfall))} shortfall keeps the org cash-positive through ${shortDate(deficitDate)}.`,
      gap_value: Math.round(shortfall),
      gap_unit: "PHP",
      is_money: true,
    },
    confidence: deficitConfidence(forecast),
    risk_tier: 3,
    required_role: "coo",
    proposed_action: {
      type: "create_cashflow_task",
      payload: {
        deficit_date: deficitDate,
        projected_shortfall: Math.round(shortfall),
        suggested_action: SUGGESTED_ACTION,
      },
    },
  };
}
