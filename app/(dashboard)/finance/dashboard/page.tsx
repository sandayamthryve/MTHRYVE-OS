import { AppShell } from "@/components/layout/AppShell";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { PageHeader, SectionCard, StatTile } from "@/components/ui";
import { requireModule } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { pesoOrDash } from "@/lib/metrics/format";
import { todayManila } from "@/lib/metrics/windows";
import { modulesForRole, workspaceRoleForProfile, type WorkspaceRole } from "@/lib/auth/module-access";
import { loadLookups, loadExpenses, rangeFilters, summarize } from "@/lib/expenses/data";
import type { Db } from "@/lib/expenses/types";
import {
  computeUtilization,
  type BudgetRow,
  type ExpenseForBudget,
} from "@/lib/finance/budgets";

/**
 * Finance workspace dashboard — the Finance view's own landing page.
 *
 * It used to render DevBentoDashboard, the shared company-wide board: Affiliate
 * GMV, CSAT, content scores, customer service, business development. None of
 * that is Finance's to see, and rendering it made the Finance rail's first icon
 * the widest surface in the role rather than its narrowest.
 *
 * Everything here comes from Finance's own modules. The module links are derived
 * from modulesForRole rather than hardcoded, so the page shows exactly what this
 * scope holds — when a grant changes the list changes with it, instead of
 * drifting into destinations the viewer would be refused at.
 *
 * It deliberately does not restate /finance (P&L, cash-flow forecast) or
 * /finance/expenses (the full Expense Dashboard). This is the way in; those are
 * the depth.
 */
export const dynamic = "force-dynamic";

// Everything short of payment — what a finance desk is actually chasing.
const OPEN_STAGES = ["encoded", "finance_review", "department_approval", "management_approval"];

export default async function FinanceDashboardPage() {
  const profile = await requireModule("/finance/dashboard");
  const role = (profile.preview_role ?? workspaceRoleForProfile(profile) ?? "operator") as WorkspaceRole;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // Month to date, the window a finance desk opens on.
  const today = todayManila();
  const monthStart = `${today.slice(0, 7)}-01`;

  let summary = { count: 0, totalGross: 0, opex: 0, capex: 0, vat: 0, net: 0 };
  const atRisk = { warning: 0, critical: 0, exceeded: 0 };
  let awaiting = 0;

  // A failed read costs a tile its number, not the page its links. This is a
  // landing surface: the way out of it matters more than the figures on it, and
  // the expense tables are not provisioned on every environment.
  try {
    const lookups = await loadLookups(db, profile.org_id);
    const rows = await loadExpenses(db, lookups, rangeFilters(monthStart, today, null), 5000);
    summary = summarize(rows);

    awaiting = rows.filter(
      (r) => r.status !== "cancelled" && r.workflow_stage != null && OPEN_STAGES.includes(r.workflow_stage)
    ).length;

    const [budgetRes, budgetExpRes] = await Promise.all([
      db.from("budgets").select("*").eq("org_id", profile.org_id),
      db
        .from("expenses")
        .select("gross_amount, transaction_date, brand_id, department_id, status, workflow_stage")
        .eq("org_id", profile.org_id),
    ]);
    const budgets = (budgetRes.data ?? []) as BudgetRow[];
    const budgetExpenses = (budgetExpRes.data ?? []) as ExpenseForBudget[];
    const refMonth = today.slice(0, 7);
    for (const b of budgets) {
      const band = computeUtilization(b, budgetExpenses, refMonth).worstBand;
      if (band === "exceeded") atRisk.exceeded += 1;
      else if (band === "critical") atRisk.critical += 1;
      else if (band === "warning") atRisk.warning += 1;
    }
  } catch {
    // Tiles read "—" rather than the page failing.
  }

  const totalAtRisk = atRisk.warning + atRisk.critical + atRisk.exceeded;
  // Exactly the modules this scope holds. Operator sees them all, which is what
  // previewing another role should show.
  const modules = modulesForRole(role);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Finance", "Dashboard"]} profile={profile}>
      <PageHeader title="Finance" subtitle={`Month to date · ${monthStart} → ${today} · Manila`} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Spend MTD" value={pesoOrDash(summary.totalGross)} hint={`${summary.count} expenses`} />
        <StatTile label="OPEX" value={pesoOrDash(summary.opex)} hint="Operating" />
        <StatTile label="CAPEX" value={pesoOrDash(summary.capex)} hint="Capital" />
        <StatTile label="VAT input" value={pesoOrDash(summary.vat)} hint="Recoverable" />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Awaiting a decision">
          {awaiting === 0 ? (
            <p className="text-sm text-ink-muted">Nothing is waiting on finance this month.</p>
          ) : (
            <p className="text-sm text-ink">
              <span className="font-mono text-2xl font-bold">{awaiting}</span>{" "}
              <span className="text-ink-muted">
                {awaiting === 1 ? "expense has" : "expenses have"} not reached payment.
              </span>
            </p>
          )}
          <Link
            href="/finance/expenses/approvals"
            className="mt-3 inline-block text-xs font-bold text-teal-300 hover:underline"
          >
            Open the approval queue →
          </Link>
        </SectionCard>

        <SectionCard title="Budgets at risk">
          {totalAtRisk === 0 ? (
            <p className="text-sm text-ink-muted">No budget has crossed 80% this month.</p>
          ) : (
            <p className="text-sm text-ink">
              <span className="font-mono text-2xl font-bold">{totalAtRisk}</span>{" "}
              <span className="text-ink-muted">
                over 80% — {atRisk.exceeded} exceeded, {atRisk.critical} critical, {atRisk.warning} warning.
              </span>
            </p>
          )}
          <Link
            href="/finance/expenses/budgets"
            className="mt-3 inline-block text-xs font-bold text-teal-300 hover:underline"
          >
            Review budgets →
          </Link>
        </SectionCard>
      </div>

      {/* Derived from the module table, so this cannot list a destination the
          viewer would be refused at. */}
      <SectionCard title="Your modules">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((module) => (
            <Link
              key={module.id}
              href={module.href}
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2.5 text-sm text-ink-muted transition hover:border-teal-400/40 hover:text-ink"
            >
              {module.label}
            </Link>
          ))}
        </div>
      </SectionCard>
    </AppShell>
  );
}
