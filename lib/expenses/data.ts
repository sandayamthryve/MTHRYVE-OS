// lib/expenses/data.ts — the shared read + aggregation layer for the Expense
// module. The dashboard, the records/search view and the export routes all read
// through here, so the totals a human sees, the rows an export contains and the
// KPIs on the dashboard are computed from one set of rules and can never drift.
//
// Reads go through the caller's RLS client (expenses are ceo/coo-only at the DB
// level), so this layer never widens access. Honest nulls are a first-class
// concern: aggregates over an EMPTY scope, ratios with no denominator, and a
// growth rate with no prior data all return null so the view can render "—"
// instead of a fabricated 0.

import {
  applyExpenseFilters,
  type ExpenseFilters,
} from "./filters";
import type {
  BudgetRow,
  CategoryGroup,
  CategoryRow,
  Db,
  ExpenseRow,
  ExpenseType,
  ExpenseView,
  NamedRef,
  VendorRow,
} from "./types";

// Coerce a PostgREST numeric (number | string | null) to a finite number, or 0.
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const EXPENSE_COLUMNS =
  "id, org_id, expense_code, transaction_date, type, category_id, allocation, brand_id, department_id, reference_number, vendor_id, vendor_name_oneoff, gross_amount, vat_amount, net_amount, payment_method, status, workflow_stage, remarks, encoded_by, approved_by, approved_at, paid_at, date_encoded, created_at, updated_at, archived_at";

// --- Lookups ----------------------------------------------------------------

export interface Lookups {
  categories: CategoryRow[];
  vendors: VendorRow[];
  brands: NamedRef[];
  departments: NamedRef[];
  campaigns: NamedRef[];
  users: NamedRef[];
  categoryById: Map<string, CategoryRow>;
  vendorById: Map<string, VendorRow>;
  brandById: Map<string, string>;
  departmentById: Map<string, string>;
  campaignById: Map<string, string>;
  userById: Map<string, string>;
}

// Load every reference list the module joins against, scoped to the caller's org
// by RLS. Returned as both ordered arrays (for filter dropdowns) and id→row maps
// (for the in-JS join that assembles an ExpenseView).
export async function loadLookups(db: Db, orgId: string): Promise<Lookups> {
  const [catRes, venRes, brandRes, deptRes, userRes, campRes] = await Promise.all([
    db
      .from("expense_categories")
      .select("id, group_name, name, gl_code, active, sort_order")
      .eq("org_id", orgId)
      .order("group_name")
      .order("sort_order"),
    db.from("vendors").select("id, name, vat_registered, active").eq("org_id", orgId).order("name"),
    db.from("brands").select("id, name").eq("org_id", orgId).order("name"),
    db.from("departments").select("id, name").eq("org_id", orgId).order("name"),
    db.from("users").select("id, full_name").eq("org_id", orgId).order("full_name"),
    db.from("campaigns").select("id, name").eq("org_id", orgId).order("name"),
  ]);

  const categories = (catRes.data ?? []) as CategoryRow[];
  const vendors = (venRes.data ?? []) as VendorRow[];
  const brands = (brandRes.data ?? []) as NamedRef[];
  const departments = (deptRes.data ?? []) as NamedRef[];
  const campaigns = (campRes.data ?? []) as NamedRef[];
  const users = ((userRes.data ?? []) as Array<{ id: string; full_name: string }>).map((u) => ({
    id: u.id,
    name: u.full_name,
  }));

  return {
    categories,
    vendors,
    brands,
    departments,
    campaigns,
    users,
    categoryById: new Map(categories.map((c) => [c.id, c])),
    vendorById: new Map(vendors.map((v) => [v.id, v])),
    brandById: new Map(brands.map((b) => [b.id, b.name])),
    departmentById: new Map(departments.map((d) => [d.id, d.name])),
    campaignById: new Map(campaigns.map((c) => [c.id, c.name])),
    userById: new Map(users.map((u) => [u.id, u.name])),
  };
}

// --- Expense reads ----------------------------------------------------------

// Normalise a raw row's money columns and assemble the display names from the
// lookup maps. A missing FK (e.g. a deactivated category) leaves the name null
// and the row survives — no silent drop the way a PostgREST inner join would.
function toView(r: ExpenseRow, lk: Lookups): ExpenseView {
  const cat = r.category_id ? lk.categoryById.get(r.category_id) ?? null : null;
  return {
    ...r,
    gross_amount: num(r.gross_amount),
    vat_amount: num(r.vat_amount),
    net_amount: r.net_amount == null ? null : num(r.net_amount),
    category_name: cat?.name ?? null,
    category_group: cat?.group_name ?? null,
    vendor_display: r.vendor_id
      ? lk.vendorById.get(r.vendor_id)?.name ?? null
      : r.vendor_name_oneoff ?? null,
    brand_name: r.brand_id ? lk.brandById.get(r.brand_id) ?? null : null,
    campaign_name: r.campaign_id ? lk.campaignById.get(r.campaign_id) ?? null : null,
    department_name: r.department_id ? lk.departmentById.get(r.department_id) ?? null : null,
    encoder_name: r.encoded_by ? lk.userById.get(r.encoded_by) ?? null : null,
    approver_name: r.approved_by ? lk.userById.get(r.approved_by) ?? null : null,
  };
}

// Load filtered expenses as display-ready views, newest transaction first. The
// same predicate powers the on-screen ledger and every export. `limit` caps the
// row count for the interactive table; exports pass a high cap.
export async function loadExpenses(
  db: Db,
  lk: Lookups,
  filters: ExpenseFilters,
  limit = 500,
  opts?: { archived?: boolean }
): Promise<ExpenseView[]> {
  let query = db.from("expenses").select(EXPENSE_COLUMNS);
  query = applyExpenseFilters(query, filters);
  query = query
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  // Default to active-only; the records/archived view opts in to archived rows.
  query = opts?.archived
    ? query.not("archived_at", "is", null)
    : query.is("archived_at", null);
  const { data } = await query;
  const rows = (data ?? []) as ExpenseRow[];
  return rows.map((r) => toView(r, lk));
}

// A filter set covering just a date window (+ optional brand) — what the
// read-only dashboard needs. Everything else is unfiltered.
export function rangeFilters(
  start: string,
  end: string,
  brandId: string | null = null
): ExpenseFilters {
  return {
    start,
    end,
    q: null,
    vendorId: null,
    brandId,
    departmentId: null,
    categoryId: null,
    type: null,
    allocation: null,
    status: null,
    paymentMethod: null,
    encoderId: null,
  };
}

// --- Aggregations (pure over an ExpenseView[]) ------------------------------
// Cancelled expenses never count toward spend — they're voided ledger entries.
// Callers that want them (the audit/records view) keep them; the money math
// here filters them out so a cancelled row can't inflate a total.
export function spendable(rows: ExpenseView[]): ExpenseView[] {
  return rows.filter((r) => r.status !== "cancelled");
}

export interface Summary {
  count: number; // spendable rows in scope
  totalGross: number;
  opex: number;
  capex: number;
  vat: number;
  net: number;
}

// The headline totals. `count` is the number of spendable rows — when it's 0 the
// view renders "—" for every tile (an empty scope is unknown spend, not ₱0). A
// subtotal that is genuinely 0 within a non-empty scope (e.g. no CAPEX this
// month) stays 0, because that's a real, observed figure.
export function summarize(rows: ExpenseView[]): Summary {
  const live = spendable(rows);
  let totalGross = 0;
  let opex = 0;
  let capex = 0;
  let vat = 0;
  let net = 0;
  for (const r of live) {
    totalGross += r.gross_amount;
    vat += r.vat_amount;
    net += r.net_amount == null ? r.gross_amount - r.vat_amount : r.net_amount;
    if (r.type === "OPEX") opex += r.gross_amount;
    else capex += r.gross_amount;
  }
  return { count: live.length, totalGross, opex, capex, vat, net };
}

export interface TrendPoint {
  month: string; // YYYY-MM
  gross: number;
  opex: number;
  capex: number;
}

// Monthly spend trend across the scope, ascending by month. Only months that
// actually have rows appear — the view labels them; it never back-fills a ₱0
// month that had no activity.
export function monthlyTrend(rows: ExpenseView[]): TrendPoint[] {
  const by = new Map<string, TrendPoint>();
  for (const r of spendable(rows)) {
    const month = (r.transaction_date ?? "").slice(0, 7);
    if (!month) continue;
    const p = by.get(month) ?? { month, gross: 0, opex: 0, capex: 0 };
    p.gross += r.gross_amount;
    if (r.type === "OPEX") p.opex += r.gross_amount;
    else p.capex += r.gross_amount;
    by.set(month, p);
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export interface GroupTotal {
  key: string; // stable key (id or label)
  label: string;
  gross: number;
  count: number;
}

// Generic "spend by X" roll-up, sorted highest-spend first. `keyOf` returns null
// for rows that don't belong to any bucket (e.g. an org-level expense has no
// brand); those collect under the caller-supplied `unassignedLabel`.
export function groupTotals(
  rows: ExpenseView[],
  keyOf: (r: ExpenseView) => { key: string; label: string } | null,
  unassignedLabel = "Unassigned"
): GroupTotal[] {
  const by = new Map<string, GroupTotal>();
  for (const r of spendable(rows)) {
    const g = keyOf(r) ?? { key: "__none__", label: unassignedLabel };
    const cur = by.get(g.key) ?? { key: g.key, label: g.label, gross: 0, count: 0 };
    cur.gross += r.gross_amount;
    cur.count += 1;
    by.set(g.key, cur);
  }
  return [...by.values()].sort((a, b) => b.gross - a.gross);
}

export const byBrand = (rows: ExpenseView[]) =>
  groupTotals(
    rows,
    (r) => (r.brand_id ? { key: r.brand_id, label: r.brand_name ?? "Unknown brand" } : null),
    "Org-level / Shared"
  );

// Cost per campaign. Most expenses are not campaign work, so the unattributed
// bucket is the norm here rather than an anomaly — naming it plainly keeps the
// slices summing to the total.
export const byCampaign = (rows: ExpenseView[]) =>
  groupTotals(
    rows,
    (r) => (r.campaign_id ? { key: r.campaign_id, label: r.campaign_name ?? "Unknown campaign" } : null),
    "Not campaign work"
  );

export const byDepartment = (rows: ExpenseView[]) =>
  groupTotals(
    rows,
    (r) =>
      r.department_id ? { key: r.department_id, label: r.department_name ?? "Unknown dept" } : null,
    "No department"
  );

export const byCategoryGroup = (rows: ExpenseView[]) =>
  groupTotals(
    rows,
    (r) => (r.category_group ? { key: r.category_group, label: r.category_group } : null),
    "Uncategorised"
  );

export const topVendors = (rows: ExpenseView[], n = 8) =>
  groupTotals(
    rows,
    (r) => {
      const label = r.vendor_display;
      if (!label) return null;
      const key = r.vendor_id ?? `oneoff:${label.toLowerCase()}`;
      return { key, label };
    },
    "No vendor"
  ).slice(0, n);

// --- KPIs (honest nulls) ----------------------------------------------------

// Average daily spend across the window. Null when the scope is empty (unknown),
// not 0 — but a real ₱0/day would only arise from a non-empty scope summing to 0.
export function avgDailySpend(summary: Summary, windowDays: number): number | null {
  if (summary.count === 0 || windowDays <= 0) return null;
  return summary.totalGross / windowDays;
}

// Monthly burn = the window's average daily spend projected to 30 days. Null on
// an empty scope so the view shows "—" rather than a fabricated run rate.
export function monthlyBurn(summary: Summary, windowDays: number): number | null {
  const daily = avgDailySpend(summary, windowDays);
  return daily == null ? null : daily * 30;
}

// Period-over-period growth as a percent. Null when there's no prior spend to
// compare against (division by zero is not 0% growth — it's unknown).
export function growthRate(current: number, prior: number): number | null {
  if (prior <= 0) return null;
  return ((current - prior) / prior) * 100;
}

export interface BudgetVsActual {
  budget: number | null; // null when no matching budget row is set
  actual: number;
  variance: number | null; // budget - actual, null when budget unknown
  utilisationPct: number | null; // actual/budget * 100, null when budget unknown
}

// Compare actual spend against the org-scope budget for a period. Budgets are
// optional: with no budget row the variance/utilisation read "—", never 0% —
// leadership shouldn't see a green "0% of budget" when no budget exists.
export function budgetVsActual(
  actual: number,
  budget: BudgetRow | null,
  months: number
): BudgetVsActual {
  if (!budget) return { budget: null, actual, variance: null, utilisationPct: null };
  const monthly = budget.monthly_budget != null ? num(budget.monthly_budget) : null;
  const annual = budget.annual_budget != null ? num(budget.annual_budget) : null;
  // Prefer an explicit monthly budget scaled to the window's month span; fall
  // back to the annual figure pro-rated per month.
  const scoped =
    monthly != null ? monthly * Math.max(months, 1) : annual != null ? (annual / 12) * Math.max(months, 1) : null;
  if (scoped == null) return { budget: null, actual, variance: null, utilisationPct: null };
  return {
    budget: scoped,
    actual,
    variance: scoped - actual,
    utilisationPct: scoped > 0 ? (actual / scoped) * 100 : null,
  };
}

// The org-scope budget row for the current fiscal period, if one exists. Budgets
// are ceo/coo-readable under RLS. `period` is matched loosely (any row scoped
// 'org') — the newest wins — because periods are free text in the schema.
export async function loadOrgBudget(db: Db, orgId: string): Promise<BudgetRow | null> {
  const { data } = await db
    .from("budgets")
    .select("id, scope, brand_id, department_id, period, annual_budget, monthly_budget")
    .eq("org_id", orgId)
    .eq("scope", "org")
    .order("created_at", { ascending: false })
    .limit(1);
  const rows = (data ?? []) as BudgetRow[];
  return rows[0] ?? null;
}

// Whole-month span (inclusive) of a YYYY-MM-DD range, for pro-rating a budget.
export function monthSpan(start: string, end: string): number {
  const [ys, ms] = start.split("-").map(Number);
  const [ye, me] = end.split("-").map(Number);
  if (!ys || !ye) return 1;
  return Math.max(1, (ye - ys) * 12 + (me - ms) + 1);
}

// Re-export for callers that only import from data.
export type { ExpenseFilters } from "./filters";
export type { ExpenseView, ExpenseType, CategoryGroup } from "./types";
