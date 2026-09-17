// lib/finance/budgets.ts — the budget monitoring DOMAIN model.
//
// The COO sets an annual and/or monthly budget per BRAND or DEPARTMENT for a
// fiscal period (a year, e.g. "2026"). Utilization is the plain sum of matching
// expenses' gross_amount for that scope + period — nothing is modelled or
// forecast here; a null budget yields honest "not set", and only real expense
// rows move the meter.
//
//   utilized = SUM(expenses.gross_amount) for {scope, period}
//   remaining = budget − utilized
//   pct = utilized / budget × 100
//
// Alert bands (fired to CEO + COO via the notifications producers): 80% warning,
// 90% critical, 100%+ exceeded. Held / rejected expenses don't count as committed
// spend, so they're excluded from utilization.
//
// The budgets + expenses tables aren't in the generated Database types, so
// callers read them through the app's cast shim and hand rows to these helpers.

// ── Row shapes (mirror the provisioned columns) ───────────────────────────────

export type BudgetScope = "brand" | "department";

export interface BudgetRow {
  id: string;
  org_id: string;
  scope: string; // 'brand' | 'department'
  brand_id: string | null;
  department_id: string | null;
  period: string; // fiscal year, e.g. "2026"
  annual_budget: number | null;
  monthly_budget: number | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

// The expense facts utilization needs.
export interface ExpenseForBudget {
  gross_amount: number | null;
  transaction_date: string | null; // YYYY-MM-DD
  brand_id: string | null;
  department_id: string | null;
  status?: string | null;
  workflow_stage?: string | null;
}

// ── Alert bands ───────────────────────────────────────────────────────────────

export type BudgetBand = "warning" | "critical" | "exceeded";

export const BUDGET_THRESHOLDS: Record<BudgetBand, number> = {
  warning: 80,
  critical: 90,
  exceeded: 100,
};

// The highest band a utilization percentage has crossed, or null below 80%.
// "exceeded" means strictly over budget (utilized > budget).
export function bandForPct(pct: number | null): BudgetBand | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct > 100) return "exceeded";
  if (pct >= BUDGET_THRESHOLDS.critical) return "critical";
  if (pct >= BUDGET_THRESHOLDS.warning) return "warning";
  return null;
}

export const BUDGET_BAND_LABEL: Record<BudgetBand, string> = {
  warning: "80% reached",
  critical: "90% reached",
  exceeded: "Over budget",
};

// A cancelled expense is not committed spend, so it never consumes budget.
// Everything still in flight or settled (pending / approved / paid / archived)
// counts, so the budget is watched from the moment spend is encoded.
export function countsTowardBudget(status: string | null | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s !== "cancelled";
}

// Does this expense belong to the budget's scope?
export function expenseMatchesScope(exp: ExpenseForBudget, budget: BudgetRow): boolean {
  if (budget.scope === "brand") return !!budget.brand_id && exp.brand_id === budget.brand_id;
  if (budget.scope === "department") {
    return !!budget.department_id && exp.department_id === budget.department_id;
  }
  return false;
}

// The 4-digit year of a YYYY-MM-DD date, or null.
function yearOf(date: string | null): string | null {
  if (!date || date.length < 4) return null;
  return date.slice(0, 4);
}
// The YYYY-MM of a YYYY-MM-DD date, or null.
function monthOf(date: string | null): string | null {
  if (!date || date.length < 7) return null;
  return date.slice(0, 7);
}

// ── Utilization ───────────────────────────────────────────────────────────────

export interface BudgetLineUtilization {
  budget: number | null; // the set budget (null = not set)
  utilized: number; // SUM(gross_amount) in scope + window
  remaining: number | null; // budget − utilized (null when budget unset)
  pct: number | null; // utilized / budget × 100 (null when budget unset)
  band: BudgetBand | null; // highest alert band crossed
}

export interface BudgetUtilization {
  budgetId: string;
  scope: BudgetScope;
  period: string;
  annual: BudgetLineUtilization;
  monthly: BudgetLineUtilization;
  // The single most severe band across annual + monthly (what an alert reports).
  worstBand: BudgetBand | null;
  worstDimension: "annual" | "monthly" | null;
}

function line(budget: number | null, utilized: number): BudgetLineUtilization {
  const b = budget != null && Number.isFinite(Number(budget)) && Number(budget) > 0 ? Number(budget) : null;
  const pct = b != null ? (utilized / b) * 100 : null;
  return {
    budget: budget != null ? Number(budget) : null,
    utilized,
    remaining: b != null ? b - utilized : null,
    pct: pct != null ? Math.round(pct * 10) / 10 : null,
    band: bandForPct(pct),
  };
}

// Severity ordering so we can pick the "worst" band to alert on.
const BAND_RANK: Record<BudgetBand, number> = { warning: 1, critical: 2, exceeded: 3 };

// Compute a budget's annual + monthly utilization against the expense list.
// `refMonth` (YYYY-MM) selects the month for the monthly line; defaults to the
// caller-supplied current month. Only expenses in the budget's scope and period
// (year for annual, refMonth for monthly) that count as committed spend are summed.
export function computeUtilization(
  budget: BudgetRow,
  expenses: ExpenseForBudget[],
  refMonth: string
): BudgetUtilization {
  let annualUtilized = 0;
  let monthlyUtilized = 0;

  for (const e of expenses) {
    if (!countsTowardBudget(e.status)) continue;
    if (!expenseMatchesScope(e, budget)) continue;
    const gross = e.gross_amount != null ? Number(e.gross_amount) : 0;
    if (!Number.isFinite(gross)) continue;
    if (yearOf(e.transaction_date) === budget.period) annualUtilized += gross;
    if (monthOf(e.transaction_date) === refMonth) monthlyUtilized += gross;
  }

  const annual = line(budget.annual_budget, annualUtilized);
  const monthly = line(budget.monthly_budget, monthlyUtilized);

  // Worst band across the two dimensions — what a single alert reports.
  let worstBand: BudgetBand | null = null;
  let worstDimension: "annual" | "monthly" | null = null;
  for (const [dim, l] of [["annual", annual] as const, ["monthly", monthly] as const]) {
    if (l.band && (!worstBand || BAND_RANK[l.band] > BAND_RANK[worstBand])) {
      worstBand = l.band;
      worstDimension = dim;
    }
  }

  return {
    budgetId: budget.id,
    scope: budget.scope === "department" ? "department" : "brand",
    period: budget.period,
    annual,
    monthly,
    worstBand,
    worstDimension,
  };
}
