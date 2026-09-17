// lib/briefings/finance-data.ts
// Finance-scoped data gathering + prompt building for the CEO/COO finance brief.
// Mirrors lib/briefings/account-data.ts, but grounds ONLY in real finance data:
// it REUSES the cash-flow forecast engine (lib/finance/forecast.ts via
// loadCashflow) as the primary input and supplements it with the finance signals
// the engine doesn't return verbatim (settlement/retainer inflows, opex/capex
// outflows, upcoming payroll, contract fees/margins).
//
// Pure, code-truthful helpers — no AI, no invented numbers. When cash_positions
// is empty the forecast is null and the prompt says so explicitly; the generator
// caps confidence and never fabricates a balance or a runway. RLS org-scopes the
// passed client (finance tables are ceo/coo only).
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadCashflow, type CashflowData } from "@/lib/finance/data";
import { EXPENSE_RUNRATE_DAYS, addDays } from "@/lib/finance/forecast";
import { todayManila } from "@/lib/metrics/windows";

type Supabase = ReturnType<typeof createServerSupabaseClient>;
// The finance tables aren't in the generated Database types, so reads go through
// this cast shim — the same escape hatch lib/finance/data.ts uses.
type Shim = { from: (t: string) => any };

export function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));

export interface FinanceData {
  // The forecast engine output — the PRIMARY input. `cashflow.forecast` is null
  // (and `cashflow.anchor` null) when no cash position has been set.
  cashflow: CashflowData;
  cashPositionsCount: number;
  settlementsCount: number;
  settlementsNetTrailing: number;
  retainerBrands: number;
  retainerMonthly: number;
  payrollRunsUpcoming: number;
  payrollUpcomingTotal: number;
  financeEntriesCount: number;
  opexTrailing: number;
  capexTrailing: number;
  contractsCount: number;
  contractsMonthlyFee: number;
  avgGrossMarginPct: number | null;
}

// The data_sources object stored on the row — exactly what the generator read.
export type FinanceDataSources = {
  cash_positions: number;
  settlements: number;
  retainer_brands: number;
  payroll_runs: number;
  finance_entries: number;
  contracts: number;
};

export function financeDataSources(data: FinanceData): FinanceDataSources {
  return {
    cash_positions: data.cashPositionsCount,
    settlements: data.settlementsCount,
    retainer_brands: data.retainerBrands,
    payroll_runs: data.payrollRunsUpcoming,
    finance_entries: data.financeEntriesCount,
    contracts: data.contractsCount,
  };
}

export async function gatherFinanceData(supabase: Supabase, orgId: string): Promise<FinanceData> {
  const db = supabase as unknown as Shim;
  const today = todayManila();
  const trailingStart = addDays(today, -(EXPENSE_RUNRATE_DAYS - 1));

  // The forecast engine is the primary input — reuse the SAME loader the Finance
  // view and the deficit producer use, so the brief reasons over identical rows.
  const [
    cashflow,
    posRes,
    settlementRes,
    retainerRes,
    payrollRes,
    entryRes,
    contractRes,
  ] = await Promise.all([
    loadCashflow(db, orgId),
    // cash_positions on file (0 today → the honest "no cash position" state).
    db.from("cash_positions").select("id").eq("org_id", orgId),
    // Settlement inflows — trailing 90d net payouts.
    db
      .from("tiktok_settlements")
      .select("net_amount, stat_date")
      .eq("org_id", orgId)
      .gte("stat_date", trailingStart)
      .lte("stat_date", today),
    // Retainer inflows — recurring monthly across the org's brands.
    db.from("brand_finance").select("retainer_monthly").eq("org_id", orgId),
    // Upcoming payroll — runs whose pay date is still in the future.
    db.from("payroll_runs").select("total, period_end, status").eq("org_id", orgId).gt("period_end", today),
    // Opex/capex outflows — trailing 90d ledger.
    db
      .from("finance_entries")
      .select("type, amount, entry_date")
      .eq("org_id", orgId)
      .gte("entry_date", trailingStart)
      .lte("entry_date", today),
    // Contract fees/margins — RLS-scoped.
    db.from("contract_financials").select("monthly_fee, gross_margin_pct"),
  ]);

  const posRows = (posRes.data ?? []) as Array<{ id: string }>;
  const settlements = (settlementRes.data ?? []) as Array<{ net_amount: number | null }>;
  const retainers = (retainerRes.data ?? []) as Array<{ retainer_monthly: number | null }>;
  const payrolls = (payrollRes.data ?? []) as Array<{ total: number | null }>;
  const entries = (entryRes.data ?? []) as Array<{ type: string; amount: number | null }>;
  const contracts = (contractRes.data ?? []) as Array<{
    monthly_fee: number | null;
    gross_margin_pct: number | null;
  }>;

  const settlementsNetTrailing = settlements.reduce((a, s) => a + num(s.net_amount), 0);
  const retainerBrandsRows = retainers.filter((r) => num(r.retainer_monthly) > 0);
  const retainerMonthly = retainerBrandsRows.reduce((a, r) => a + num(r.retainer_monthly), 0);
  const payrollUpcomingTotal = payrolls.reduce((a, p) => a + num(p.total), 0);
  const opexTrailing = entries.filter((e) => e.type === "opex").reduce((a, e) => a + num(e.amount), 0);
  const capexTrailing = entries.filter((e) => e.type === "capex").reduce((a, e) => a + num(e.amount), 0);
  const contractsMonthlyFee = contracts.reduce((a, c) => a + num(c.monthly_fee), 0);
  const marginRows = contracts.filter((c) => c.gross_margin_pct != null);
  const avgGrossMarginPct = marginRows.length
    ? marginRows.reduce((a, c) => a + num(c.gross_margin_pct), 0) / marginRows.length
    : null;

  return {
    cashflow,
    cashPositionsCount: posRows.length,
    settlementsCount: settlements.length,
    settlementsNetTrailing,
    retainerBrands: retainerBrandsRows.length,
    retainerMonthly,
    payrollRunsUpcoming: payrolls.length,
    payrollUpcomingTotal,
    financeEntriesCount: entries.length,
    opexTrailing,
    capexTrailing,
    contractsCount: contracts.length,
    contractsMonthlyFee,
    avgGrossMarginPct,
  };
}

// True when there is essentially nothing to brief on — no cash anchor AND no
// finance signals at all. The generator records an honest "insufficient" note
// for this case instead of calling the model.
export function financeIsEmpty(data: FinanceData): boolean {
  return (
    !data.cashflow.anchor &&
    data.settlementsCount === 0 &&
    data.retainerBrands === 0 &&
    data.financeEntriesCount === 0 &&
    data.payrollRunsUpcoming === 0 &&
    data.contractsCount === 0
  );
}

// Code-truthful baseline confidence. Capped to "low" whenever no cash position
// is set — the forecast can't produce a trustworthy runway without an anchor.
export function financeBaselineConfidence(data: FinanceData): string {
  if (!data.cashflow.anchor) return "low";
  const hasSignals =
    data.settlementsCount > 0 ||
    data.retainerBrands > 0 ||
    data.financeEntriesCount > 0 ||
    data.payrollRunsUpcoming > 0;
  return hasSignals ? "medium" : "low";
}

export const FINANCE_SYSTEM_PROMPT =
  "You are the CFO/finance strategist for a Philippine TikTok Shop & Shopee agency, briefing the CEO and COO. " +
  "Using ONLY the data provided, never invent or estimate any number — especially never assume a cash balance or a runway. " +
  "If no cash position is set, say so plainly in the summary, treat runway as unknown, and lower your confidence. " +
  "If the inputs are thin, say the inputs are thin. " +
  "Assess the cash-flow and P&L picture, then give EXACTLY 3 forward-looking solutions that get ahead of the risks, " +
  "each with a one-line 'why' and exactly 3 concrete next steps. " +
  "challenges are the concrete problems; bottlenecks are the underlying root causes. " +
  'Respond ONLY as strict JSON: {"data_confidence":"high|medium|low|insufficient","summary":"...",' +
  '"challenges":["..."],"bottlenecks":["..."],' +
  '"solutions":[{"solution":"...","why":"...","steps":["...","...","..."]}]}';

// Build the compact, factual finance context the model may reason over. Every
// line is a real figure or an honest "not set / none" — no fabricated balances.
export function buildFinancePrompt(data: FinanceData): string {
  const lines: string[] = [];
  const cf = data.cashflow;

  if (!cf.anchor || !cf.forecast) {
    lines.push(
      "Cash position: NONE SET — the cash_positions table is empty. " +
        "There is no cash balance and no runway to report; do NOT assume or invent either."
    );
  } else {
    const f = cf.forecast;
    const d = f.drivers;
    lines.push(
      `Cash position: ${peso(num(cf.anchor.amount))} as of ${cf.anchor.as_of_date}` +
        (cf.anchor.account ? ` (${cf.anchor.account})` : "") + "."
    );
    lines.push(
      `Forecast over ${d.horizonDays}d: projected end balance ${peso(f.endBalance)}, ` +
        `minimum ${peso(f.minBalance)} on ${f.minDate}.`
    );
    lines.push(
      f.deficitDate
        ? `Runway: projected to breach the ${peso(d.safetyBuffer)} safety buffer on ${f.deficitDate} ` +
          `(${f.runwayDays} days out), projected shortfall ${peso(num(f.projectedShortfall))}.`
        : `Runway: no deficit within the ${d.horizonDays}-day horizon at the current run-rate.`
    );
    lines.push(
      `Daily drift: expense run-rate ${peso(d.expenseRunRateDaily)}/day out, ` +
        `settlement run-rate ${peso(d.settlementRunRateDaily)}/day in, ` +
        `net avg ${peso(d.avgDailyNet)}/day.`
    );
    if (d.nextPayroll) {
      lines.push(`Next payroll inside horizon: ${peso(d.nextPayroll.total)} on ${d.nextPayroll.date}.`);
    }
  }

  lines.push(
    `Settlement inflows (TikTok, trailing ${EXPENSE_RUNRATE_DAYS}d): ` +
      (data.settlementsCount
        ? `${peso(data.settlementsNetTrailing)} net across ${data.settlementsCount} settlement rows.`
        : "no settlement rows on file.")
  );
  lines.push(
    `Retainer inflows: ${data.retainerBrands
      ? `${peso(data.retainerMonthly)}/mo recurring across ${data.retainerBrands} brand(s).`
      : "no retainer brands configured."}`
  );
  lines.push(
    `Upcoming payroll: ${data.payrollRunsUpcoming
      ? `${peso(data.payrollUpcomingTotal)} across ${data.payrollRunsUpcoming} run(s).`
      : "no upcoming payroll runs."}`
  );
  lines.push(
    `Ledger outflows (trailing ${EXPENSE_RUNRATE_DAYS}d, ${data.financeEntriesCount} entries): ` +
      `opex ${peso(data.opexTrailing)}, capex ${peso(data.capexTrailing)}.`
  );
  lines.push(
    `Contracts: ${data.contractsCount
      ? `${data.contractsCount} with ${peso(data.contractsMonthlyFee)}/mo total fees` +
        (data.avgGrossMarginPct != null ? `, avg gross margin ${data.avgGrossMarginPct.toFixed(1)}%.` : ".")
      : "no contract financials on file."}`
  );
  return lines.join("\n");
}
