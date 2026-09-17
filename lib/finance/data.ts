// lib/finance/data.ts — the SHARED cash-flow data layer.
//
// One reader that pulls the latest cash_positions anchor plus every finance
// signal the forecast needs (payroll_runs, finance_entries, brand_finance
// retainers, tiktok_settlements), scoped to the caller's org, and hands them to
// the pure engine (lib/finance/forecast.ts). The Finance view and the "Scan cash
// flow" producer BOTH call this, so the projected balance a human sees and the
// deficit Tony flags are computed from identical inputs — they can never drift.
//
// Finance surfaces are ceo/coo only; RLS on cash_positions / finance_entries /
// payroll_runs / brand_finance already enforces that, so this layer just reads
// through the caller's client. tiktok_settlements is org-scoped select. When no
// cash position has been set the loader returns { anchor:null, forecast:null } so
// the view can show the honest "no cash position set" state instead of a
// fabricated projection.

import {
  buildCashForecast,
  latestCashPosition,
  EXPENSE_RUNRATE_DAYS,
  SETTLEMENT_RUNRATE_DAYS,
  DEFAULT_HORIZON_DAYS,
  DEFAULT_SAFETY_BUFFER,
  addDays,
  type CashPosition,
  type PayrollRun,
  type FinanceEntry,
  type Settlement,
  type CashForecast,
} from "./forecast";
import { todayManila } from "@/lib/metrics/windows";
import { checkPolicy } from "@/lib/governance/policy";

// The finance tables aren't in the generated Database types, so — like the Live,
// Contracts and Warehouse modules — reads go through this cast shim.
type Shim = { from: (t: string) => any };

export interface CashflowData {
  anchor: CashPosition | null;
  forecast: CashForecast | null; // null iff anchor is null
  horizonDays: number;
  safetyBuffer: number;
  today: string; // Asia/Manila, for "as of" freshness vs the anchor
}

export interface LoadCashflowOptions {
  horizonDays?: number;
  safetyBuffer?: number;
  today?: string;
  // The caller's role, so the read can be gated by the Policy Registry's
  // data_access rule (finance data restricted to ceo/coo). When omitted the
  // consult is skipped — RLS on the finance tables still enforces the same gate.
  actorRole?: string | null;
  actorId?: string | null;
}

export async function loadCashflow(
  db: Shim,
  orgId: string,
  opts: LoadCashflowOptions = {}
): Promise<CashflowData> {
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const safetyBuffer = opts.safetyBuffer ?? DEFAULT_SAFETY_BUFFER;
  const today = opts.today ?? todayManila();

  // Data-access gate, from the Policy Registry: finance data is restricted to
  // the roles the rule names (ceo/coo by default). If leadership narrows those
  // roles in the Governance screen, this read returns the honest empty state for
  // a now-disallowed role with no code change. RLS remains the hard enforcement.
  if (opts.actorRole != null) {
    const gate = await checkPolicy("finance_read", {
      orgId,
      db,
      actorRole: opts.actorRole,
      actorId: opts.actorId ?? null,
      detail: { horizon_days: horizonDays },
    });
    if (gate.decision === "deny") {
      return { anchor: null, forecast: null, horizonDays, safetyBuffer, today };
    }
  }

  // The anchor: latest cash position for the org. Read the most recent handful
  // and pick with the shared tie-breaker rather than trusting a single order.
  const { data: posRows } = await db
    .from("cash_positions")
    .select("amount, as_of_date, account, note, created_at")
    .eq("org_id", orgId)
    .order("as_of_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10);
  const anchor = latestCashPosition((posRows ?? []) as CashPosition[]);

  if (!anchor) {
    return { anchor: null, forecast: null, horizonDays, safetyBuffer, today };
  }

  const asOf = anchor.as_of_date;
  const horizonEnd = addDays(asOf, horizonDays);
  const trailingExpenseStart = addDays(asOf, -(EXPENSE_RUNRATE_DAYS - 1));
  const trailingSettlementStart = addDays(asOf, -(SETTLEMENT_RUNRATE_DAYS - 1));

  // Fetch the remaining inputs in parallel, each scoped to the org + the exact
  // date span the engine reads (trailing run-rate windows + the future horizon).
  const [payrollRes, entryRes, retainerRes, settlementRes] = await Promise.all([
    // Payroll: any run whose pay date lands inside the horizon (draft or posted).
    db
      .from("payroll_runs")
      .select("id, period_start, period_end, status, total, finance_entry_id")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .gt("period_end", asOf)
      .lte("period_end", horizonEnd),
    // Ledger: trailing outflows (for the run-rate) + future-dated rows (discrete).
    db
      .from("finance_entries")
      .select("id, entry_date, type, category, amount")
      .eq("org_id", orgId)
      .is("archived_at", null)
      .gte("entry_date", trailingExpenseStart)
      .lte("entry_date", horizonEnd),
    // Recurring retainer inflow across the org's brands.
    db.from("brand_finance").select("retainer_monthly").eq("org_id", orgId),
    // Settlement inflow run-rate: the trailing window's net payouts.
    db
      .from("tiktok_settlements")
      .select("stat_date, net_amount")
      .eq("org_id", orgId)
      .gte("stat_date", trailingSettlementStart)
      .lte("stat_date", asOf),
  ]);

  const payrollRuns = (payrollRes.data ?? []) as PayrollRun[];
  const financeEntries = (entryRes.data ?? []) as FinanceEntry[];
  const settlements = (settlementRes.data ?? []) as Settlement[];
  const retainerMonthly = ((retainerRes.data ?? []) as Array<{ retainer_monthly: number | null }>).reduce(
    (a, r) => a + Number(r.retainer_monthly ?? 0),
    0
  );

  const forecast = buildCashForecast({
    anchor,
    payrollRuns,
    financeEntries,
    settlements,
    retainerMonthly,
    horizonDays,
    safetyBuffer,
    settlementWindowDays: SETTLEMENT_RUNRATE_DAYS,
  });

  return { anchor, forecast, horizonDays, safetyBuffer, today };
}
