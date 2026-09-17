import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass, Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { pesoOrDash, EMPTY } from "@/lib/metrics/format";
import { todayManila } from "@/lib/metrics/windows";
import { DateRangeControls } from "../../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import {
  loadLookups,
  loadExpenses,
  rangeFilters,
  summarize,
  monthlyTrend,
  byBrand,
  byDepartment,
  byCategoryGroup,
  byCampaign,
  topVendors,
  avgDailySpend,
  monthlyBurn,
  growthRate,
  type GroupTotal,
} from "@/lib/expenses/data";
import type { Db } from "@/lib/expenses/types";
import {
  computeUtilization,
  type BudgetRow,
  type ExpenseForBudget,
} from "@/lib/finance/budgets";

// EXPENSE DASHBOARD — read-only executive analytics over the expense ledger.
// ceo/coo only. Reads through the caller's RLS client and renders Summary /
// Monthly Analysis / KPIs / Cost-per-Brand + a budget-health tile derived from
// the F2 budget model. Honest nulls throughout — an unknown reads "—", never a
// fabricated 0. Manage the ledger from Records; set budgets under Budgets.
export const dynamic = "force-dynamic";

function windowDays(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

function SpendBars({ rows, total }: { rows: GroupTotal[]; total: number }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-muted">No spend recorded in this window.</p>;
  }
  const max = Math.max(...rows.map((r) => r.gross), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => {
        const pct = total > 0 ? (r.gross / total) * 100 : 0;
        return (
          <li key={r.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-ink">{r.label}</span>
              <span className="shrink-0 font-mono text-xs text-ink-muted">
                {pesoOrDash(r.gross)} · {total > 0 ? `${Math.round(pct)}%` : EMPTY}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-charcoal-800">
              <div className="h-full rounded-full bg-teal-500/60" style={{ width: `${Math.max(2, (r.gross / max) * 100)}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default async function ExpenseDashboardPage({
  searchParams,
}: {
  searchParams?: DateRangeSearchParams;
}) {
  const profile = await requireModule("/finance/expenses");
  const orgId = profile.org_id;
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const { range, compareRange, brandId } = dr;

  const lookups = await loadLookups(db, orgId);

  const [rows, priorRows, budgetRes, budgetExpRes] = await Promise.all([
    loadExpenses(db, lookups, rangeFilters(range.start, range.end, brandId), 5000),
    compareRange
      ? loadExpenses(db, lookups, rangeFilters(compareRange.start, compareRange.end, brandId), 5000)
      : Promise.resolve([]),
    // Budget health (F2 model) — org-wide, independent of the selected window.
    db.from("budgets").select("*").eq("org_id", orgId),
    db
      .from("expenses")
      .select("gross_amount, transaction_date, brand_id, department_id, status, workflow_stage")
      .eq("org_id", orgId)
      .is("archived_at", null),
  ]);

  const summary = summarize(rows);
  const priorSummary = summarize(priorRows);
  const empty = summary.count === 0;

  const days = windowDays(range.start, range.end);
  const daily = avgDailySpend(summary, days);
  const burn = monthlyBurn(summary, days);
  const growth = compareRange ? growthRate(summary.totalGross, priorSummary.totalGross) : null;

  // Budget health from the F2 budget model: how many budgets have crossed a band.
  const budgets = (budgetRes.data ?? []) as BudgetRow[];
  const budgetExpenses = (budgetExpRes.data ?? []) as ExpenseForBudget[];
  const refMonth = todayManila().slice(0, 7);
  const bands = budgets.map((b) => computeUtilization(b, budgetExpenses, refMonth).worstBand);
  const exceeded = bands.filter((b) => b === "exceeded").length;
  const critical = bands.filter((b) => b === "critical").length;
  const warning = bands.filter((b) => b === "warning").length;
  const atRisk = exceeded + critical + warning;

  const trend = monthlyTrend(rows);
  const brands = byBrand(rows);
  const depts = byDepartment(rows);
  const cats = byCategoryGroup(rows);
  const vendors = topVendors(rows, 8);
  const campaigns = byCampaign(rows);

  const growthDir = growth == null ? undefined : growth > 0 ? "up" : growth < 0 ? "down" : "flat";

  return (
    <AppShell breadcrumb={["Finance", "Expenses"]} profile={profile}>
      <PageHeader
        title="Expense Dashboard"
        subtitle={`Read-only · ${dr.rangeLabel}${brandId ? ` · ${lookups.brandById.get(brandId) ?? "brand"}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <Link href="/finance/expenses/records" className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Records
            </Link>
            <Link href="/finance/expenses/budgets" className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Budgets
            </Link>
            <Link href="/finance/expenses/audit" className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Audit
            </Link>
          </div>
        }
      />

      <DateRangeControls {...dr.controlProps} brands={lookups.brands} />

      {/* SUMMARY — Total, OPEX, CAPEX, VAT input, Net. Empty scope → "—". */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Total Spend" value={empty ? EMPTY : pesoOrDash(summary.totalGross)} hint={empty ? "No expenses in window" : `${summary.count} entries`} />
        <StatTile label="OPEX" value={empty ? EMPTY : pesoOrDash(summary.opex)} />
        <StatTile label="CAPEX" value={empty ? EMPTY : pesoOrDash(summary.capex)} />
        <StatTile label="VAT Input" value={empty ? EMPTY : pesoOrDash(summary.vat)} hint="Creditable input VAT" />
        <StatTile label="Net of VAT" value={empty ? EMPTY : pesoOrDash(summary.net)} hint="Gross − VAT input" />
      </div>

      {/* KPIs — avg daily, burn (+growth delta), budget health (F2), growth.
          Honest nulls: "—" when the input is genuinely absent, never a fake 0. */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Avg Daily Spend" value={daily == null ? EMPTY : pesoOrDash(daily)} hint={`over ${days} day${days === 1 ? "" : "s"}`} />
        <StatTile
          label="Monthly Burn Rate"
          value={burn == null ? EMPTY : pesoOrDash(burn)}
          delta={growth == null ? undefined : { value: `${growth > 0 ? "+" : ""}${Math.round(growth)}% ${dr.compareLabel ?? ""}`, direction: growthDir }}
          hint={growth == null ? "30-day projection" : undefined}
        />
        <StatTile
          label="Budgets at Risk"
          value={budgets.length === 0 ? EMPTY : String(atRisk)}
          valueClassName={exceeded > 0 ? "text-red-300" : critical > 0 ? "text-amber-300" : "text-ink"}
          hint={budgets.length === 0 ? "No budgets set" : `${exceeded} over · ${critical} at 90% · ${warning} at 80%`}
        />
        <StatTile label="Period Growth" value={growth == null ? EMPTY : `${growth > 0 ? "+" : ""}${Math.round(growth)}%`} hint={dr.compareLabel ?? "Select a compare window"} />
      </div>

      {/* MONTHLY ANALYSIS — trend + spend by category group. */}
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <SectionCard title="Monthly Trend" className="lg:col-span-2">
          {trend.length === 0 ? (
            <p className="text-sm text-ink-muted">No spend recorded in this window.</p>
          ) : (
            <TableShell columns={["Month", "OPEX", "CAPEX", "Total"]}>
              {trend.map((t) => (
                <tr key={t.month} className={rowClass}>
                  <td className="p-3 font-mono text-xs text-ink">{t.month}</td>
                  <td className="p-3 text-ink-muted">{pesoOrDash(t.opex)}</td>
                  <td className="p-3 text-ink-muted">{pesoOrDash(t.capex)}</td>
                  <td className="p-3 font-medium text-ink">{pesoOrDash(t.gross)}</td>
                </tr>
              ))}
            </TableShell>
          )}
        </SectionCard>

        <SectionCard title="Spend by Category">
          <SpendBars rows={cats} total={summary.totalGross} />
        </SectionCard>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <SectionCard title="Cost per Brand">
          <SpendBars rows={brands} total={summary.totalGross} />
        </SectionCard>
        <SectionCard title="Spend by Department">
          <SpendBars rows={depts} total={summary.totalGross} />
        </SectionCard>
        {/* Cost per campaign. Expenses gained campaign_id in
            20260917030000_expense_campaign.sql — before that there was no
            dimension to group by, so this widget could not be built without
            inventing one. Most spend is not campaign work, so the
            "Not campaign work" bucket carrying the bulk is expected. */}
        <SectionCard title="Cost per Campaign">
          <SpendBars rows={campaigns} total={summary.totalGross} />
        </SectionCard>
        <SectionCard title="Top Vendors">
          {vendors.length === 0 ? (
            <p className="text-sm text-ink-muted">No vendor spend in this window.</p>
          ) : (
            <ul className="space-y-2">
              {vendors.map((v) => (
                <li key={v.key} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate text-ink">{v.label}</span>
                  <span className="shrink-0 font-mono text-xs text-ink-muted">
                    {pesoOrDash(v.gross)}
                    <span className="ml-1 text-ink-dim">· {v.count}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <p className="text-xs text-ink-dim">
        <Badge tone="muted">Read-only</Badge> Figures reflect non-cancelled ledger entries with a transaction date in the
        selected window. Encode, submit and approve from{" "}
        <Link href="/finance/expenses/records" className="text-teal-300 hover:underline">
          Records
        </Link>
        ; set and monitor budgets under{" "}
        <Link href="/finance/expenses/budgets" className="text-teal-300 hover:underline">
          Budgets
        </Link>
        .
      </p>
    </AppShell>
  );
}
