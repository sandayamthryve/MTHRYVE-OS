import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass, Badge } from "@/components/ui";
import { requireModule, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

type ApprovalRow = {
  id: string;
  expense_code: string;
  vendor_name: string;
  category: string;
  brand: string;
  department: string;
  gross_amount: number;
  net_amount: number;
  transaction_date: string;
  current_stage: number;
  workflow_stage: "encoded" | "finance_review" | "department_approval" | "management_approval" | "ready_for_payment" | "paid" | "archived";
  submitted_by: string;
  submitted_at: string;
  current_approver?: string;
  days_pending: number;
};

const WORKFLOW_STAGES = [
  { key: "encoded", label: "1. Expense Encoded", order: 1 },
  { key: "finance_review", label: "2. Finance Review", order: 2 },
  { key: "department_approval", label: "3. Department Approval", order: 3 },
  { key: "management_approval", label: "4. Management Approval", order: 4 },
  { key: "ready_for_payment", label: "5. Ready for Payment", order: 5 },
  { key: "paid", label: "6. Paid", order: 6 },
  { key: "archived", label: "7. Archived", order: 7 },
] as const;

function StageBadge({ stage, current }: { stage: (typeof WORKFLOW_STAGES)[number]; current: boolean }) {
  return (
    <Badge tone={current ? "success" : "muted"} className={current ? "bg-teal-500/20 text-teal-300 border-teal-500/30" : ""}>
      {stage.label}
    </Badge>
  );
}

function workflowProgress(currentStage: number) {
  return WORKFLOW_STAGES.map((s) => (
    <span key={s.key} className="flex items-center gap-1">
      <StageBadge stage={s} current={s.order === currentStage} />
      {s.order < WORKFLOW_STAGES.length && <span className="text-ink-dim mx-1">→</span>}
    </span>
  ));
}

async function loadApprovals(orgId: string) {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("expense_approvals_view")
    .select("*")
    .eq("org_id", orgId)
    .in("workflow_stage", ["encoded", "finance_review", "department_approval", "management_approval", "ready_for_payment"])
    .order("submitted_at", { ascending: true });
  return (data ?? []) as ApprovalRow[];
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 }).format(amount);
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

export default async function ExpenseApprovalsPage() {
  // Guarded by the module, like every sibling in the Money group. It was
  // requireRole(["ceo","coo"]), which no preview scope satisfies, so the
  // page was unopenable for the very role that needs it. Writes stay
  // leadership-only through RLS on the rows.
  const profile = await requireModule("/finance/expenses/approvals");
  const approvals = await loadApprovals(profile.org_id);

  const byStage = WORKFLOW_STAGES.slice(0, 5).map((s) => ({
    stage: s,
    count: approvals.filter((a) => a.workflow_stage === s.key).length,
  }));

  return (
    <AppShell breadcrumb={["Finance", "Expenses", "Approvals"]} profile={profile}>
      <PageHeader
        title="Expense Approvals"
        subtitle={`Finance-specific queue · ${approvals.length} pending · ${byStage.reduce((a, b) => a + b.count, 0)} active`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="max-w-[200px] rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink focus:border-teal-500 focus:outline-none"
              aria-label="Filter by stage"
            >
              <option value="">All Stages</option>
              {WORKFLOW_STAGES.slice(0, 5).map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <select
              className="max-w-[180px] rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink focus:border-teal-500 focus:outline-none"
              aria-label="Filter by brand"
            >
              <option value="">All Brands</option>
            </select>
            <input
              type="text"
              placeholder="Search code, vendor..."
              className="max-w-xs rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500 focus:outline-none"
              aria-label="Search approvals"
            />
          </div>
        }
      />

      {/* Workflow Progress Bar */}
      <SectionCard title="Approval Workflow" className="mb-6">
        <div className="overflow-x-auto pb-2 flex flex-wrap gap-2">
          {workflowProgress(0)}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-7">
          {byStage.map(({ stage, count }) => (
            <div
              key={stage.key}
              className={`p-3 rounded-lg text-center text-sm ${
                count > 0 ? "bg-teal-500/10 border border-teal-500/30" : "bg-charcoal-800/50 border border-charcoal-700"
              }`}
            >
              <p className={`font-mono text-lg font-bold ${count > 0 ? "text-teal-400" : "text-ink"}`}>{count}</p>
              <p className="text-xs text-ink-muted truncate">{stage.label.split(". ")[1]}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Approvals Table */}
      <SectionCard title="Pending Approvals">
        {approvals.length === 0 ? (
          <p className="text-sm text-ink-muted text-center py-8">No pending expense approvals.</p>
        ) : (
          <>
            <TableShell
              columns={[
                "Expense Code",
                "Vendor",
                "Category",
                "Brand",
                "Department",
                "Amount",
                "Stage",
                "Submitted By",
                "Submitted",
                "Days Pending",
                "Actions",
              ]}
            >
              {approvals.map((a) => (
                <tr key={a.id} className={rowClass}>
                  <td className="p-3 font-mono text-sm font-medium text-teal-300">{a.expense_code}</td>
                  <td className="p-3 text-ink-muted">{a.vendor_name}</td>
                  <td className="p-3"><Badge tone="muted">{a.category}</Badge></td>
                  <td className="p-3 text-ink-muted">{a.brand}</td>
                  <td className="p-3 text-ink-dim">{a.department}</td>
                  <td className="p-3 font-mono text-ink">{formatCurrency(a.gross_amount)}</td>
                  <td className="p-3">
                    <StageBadge stage={WORKFLOW_STAGES.find((s) => s.key === a.workflow_stage)!} current={true} />
                  </td>
                  <td className="p-3 text-ink-dim">{a.submitted_by}</td>
                  <td className="p-3 text-ink-dim font-mono text-xs">{formatDate(a.submitted_at)}</td>
                  <td className={`p-3 font-mono text-sm ${a.days_pending > 3 ? "text-amber-400" : "text-ink"}`}>{a.days_pending}d</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/finance/expenses/approvals/${a.id}`}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                      >
                        Review
                      </Link>
                      <Link
                        href={`/finance/expenses/records/${a.expense_code}`}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                      >
                        View Expense
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </TableShell>

            {/* SLA Warning */}
            {approvals.some((a) => a.days_pending > 3) && (
              <div className="mt-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <p className="text-sm text-amber-300">
                  <strong>SLA Alert:</strong> {approvals.filter((a) => a.days_pending > 3).length} approval{"s" + ""} exceeded 3-day SLA.{" "}
                  Per policy, flag before deadline — escalate to next approver.
                </p>
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* Quick Stats */}
      <SectionCard title="Queue Health" className="mt-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-teal-400">{approvals.length}</p>
            <p className="text-sm text-ink-muted">Total Pending</p>
          </div>
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-amber-400">
              {approvals.filter((a) => a.days_pending > 3).length}
            </p>
            <p className="text-sm text-ink-muted">Over 3 Days</p>
          </div>
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-red-400">
              {approvals.filter((a) => a.days_pending > 7).length}
            </p>
            <p className="text-sm text-ink-muted">Over 7 Days</p>
          </div>
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-green-400">
              {approvals.filter((a) => a.workflow_stage === "ready_for_payment").length}
            </p>
            <p className="text-sm text-ink-muted">Ready for Payment</p>
          </div>
        </div>
      </SectionCard>
    </AppShell>
  );
}