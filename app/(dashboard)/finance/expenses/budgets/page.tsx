import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, Badge, rowClass, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { todayManila } from "@/lib/metrics/windows";
import {
  computeUtilization,
  BUDGET_BAND_LABEL,
  type BudgetRow,
  type ExpenseForBudget,
  type BudgetBand,
  type BudgetLineUtilization,
} from "@/lib/finance/budgets";
import { SetBudgetForm, ScanBudgetsButton, type Option } from "./BudgetControls";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Budget monitoring — LEADERSHIP read (ceo/coo); the COO sets budgets. Utilization
// is the plain sum of matching expenses' gross_amount for the scope + period.
// Alerts (80 / 90 / exceeded) fire to CEO + COO via notifications.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

const BAND_TONE: Record<BudgetBand, BadgeTone> = {
  warning: "amber",
  critical: "amber",
  exceeded: "red",
};

// A utilization meter: label, amounts, % bar tinted by band.
function Meter({ title, line }: { title: string; line: BudgetLineUtilization }) {
  if (line.budget == null) {
    return (
      <div>
        <p className="mb-1 text-[11px] font-mono uppercase tracking-wider text-ink-dim">{title}</p>
        <p className="text-xs text-ink-muted">
          Not set. Utilized {peso(line.utilized)} — no budget to measure against.
        </p>
      </div>
    );
  }
  const pct = line.pct ?? 0;
  const barPct = Math.max(0, Math.min(100, pct));
  const barColor =
    line.band === "exceeded" ? "bg-red-500" : line.band === "critical" ? "bg-amber-500" : line.band === "warning" ? "bg-amber-400" : "bg-teal-500";
  const remainLabel =
    line.remaining != null
      ? line.remaining >= 0
        ? `${peso(line.remaining)} left`
        : `${peso(Math.abs(line.remaining))} over`
      : "—";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-mono uppercase tracking-wider text-ink-dim">{title}</span>
        <span className="text-ink-muted">
          {peso(line.utilized)} / {peso(line.budget)} ·{" "}
          <span className={line.band === "exceeded" ? "text-red-300" : "text-ink"}>{pct}%</span>
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-charcoal-800">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${barPct}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className={line.remaining != null && line.remaining < 0 ? "text-red-300" : "text-ink-muted"}>
          {remainLabel}
        </span>
        {line.band && <Badge tone={BAND_TONE[line.band]}>{BUDGET_BAND_LABEL[line.band]}</Badge>}
      </div>
    </div>
  );
}

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const profile = await requireModule("/finance/expenses/budgets");
  const db = createServerSupabaseClient() as unknown as Shim;
  const isCoo = profile.role === "coo";
  const archived = searchParams?.archived === "1";
  const refMonth = todayManila().slice(0, 7);
  const currentYear = todayManila().slice(0, 4);

  // The budget list flips between active and archived; the expenses utilization
  // read always excludes archived rows so utilization never counts archived cost.
  const budgetQuery = db.from("budgets").select("*").eq("org_id", profile.org_id);
  const [budgetRes, expRes, brandRes, deptRes] = await Promise.all([
    archived ? budgetQuery.not("archived_at", "is", null) : budgetQuery.is("archived_at", null),
    db
      .from("expenses")
      .select("gross_amount, transaction_date, brand_id, department_id, status, workflow_stage")
      .eq("org_id", profile.org_id)
      .is("archived_at", null),
    db.from("brands").select("id, name").order("name"),
    db.from("departments").select("id, name").order("name"),
  ]);

  const budgets = (budgetRes.data ?? []) as BudgetRow[];
  const expenses = (expRes.data ?? []) as ExpenseForBudget[];
  const brands = (brandRes.data ?? []) as Option[];
  const departments = (deptRes.data ?? []) as Option[];
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  const rows = budgets
    .map((b) => ({ budget: b, util: computeUtilization(b, expenses, refMonth) }))
    .sort((a, b) => a.budget.period.localeCompare(b.budget.period) || a.budget.scope.localeCompare(b.budget.scope));

  const scopeLabel = (b: BudgetRow) =>
    b.scope === "department"
      ? (b.department_id && deptName.get(b.department_id)) || "—"
      : (b.brand_id && brandName.get(b.brand_id)) || "—";

  return (
    <AppShell breadcrumb={["Mthryve OS", "Finance", "Budgets"]} profile={profile}>
      <PageHeader
        title="Budget monitoring"
        subtitle={
          <>
            Utilized = sum of expense gross amounts for the scope + period. Alerts at 80% / 90% / over fire
            to CEO + COO.
          </>
        }
        action={<ScanBudgetsButton />}
      />

      {isCoo && (
        <SectionCard title="Set a budget" className="mb-8">
          <SetBudgetForm brands={brands} departments={departments} defaultPeriod={currentYear} />
        </SectionCard>
      )}

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          {archived ? "Archived budgets" : "Budgets & utilization"}
        </h2>
        <ArchivedToggle basePath="/finance/expenses/budgets" archived={archived} />
      </div>
      <TableShell columns={["Scope", "Period", "Annual", "Monthly", "Manage"]}>
        {rows.length === 0 && (
          <tr>
            <td colSpan={5} className="p-4 text-ink-muted">
              No budgets set. {isCoo ? "Set one above." : "The COO can set budgets."}
            </td>
          </tr>
        )}
        {rows.map(({ budget, util }) => (
          <tr key={budget.id} className={rowClass}>
            <td className="p-3 align-top">
              <div className="text-ink">{scopeLabel(budget)}</div>
              <Badge tone="muted">{budget.scope}</Badge>
            </td>
            <td className="p-3 align-top font-mono text-xs text-ink-muted">{budget.period}</td>
            <td className="p-3 align-top" style={{ minWidth: "16rem" }}>
              <Meter title="Annual" line={util.annual} />
            </td>
            <td className="p-3 align-top" style={{ minWidth: "16rem" }}>
              <Meter title={`Monthly · ${refMonth}`} line={util.monthly} />
            </td>
            <td className="p-3 align-top">
              <RowActions {...rowActionProps("budgets", budget as unknown as Record<string, unknown>, profile)} />
            </td>
          </tr>
        ))}
      </TableShell>

      <p className="mt-4 text-xs text-ink-muted">
        Cancelled expenses don&apos;t count as committed spend. Encoded, in-review, approved, paid and
        archived expenses all count toward utilization — so the budget is watched from the moment spend is
        recorded, not only after payment.
      </p>
    </AppShell>
  );
}
