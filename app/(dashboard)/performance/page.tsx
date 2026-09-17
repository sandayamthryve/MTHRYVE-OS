import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass, Badge, StatTile } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

type EvaluationRow = {
  id: string;
  employee_name: string;
  department: string;
  period: string;
  status: "draft" | "pending_review" | "completed" | "acknowledged";
  overall_score?: number;
  evaluator_name?: string;
  due_date?: string;
  created_at: string;
};

type KPIRow = {
  id: string;
  employee_name: string;
  kpi_name: string;
  target: number;
  actual: number;
  weight: number;
  period: string;
};

async function loadPerformanceData(orgId: string) {
  const supabase = createServerSupabaseClient();
  const [{ data: evaluations }, { data: kpis }] = await Promise.all([
    supabase.from("performance_evaluations").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(200),
    supabase.from("performance_kpis").select("*").eq("org_id", orgId).order("period", { ascending: false }).limit(500),
  ]);
  return {
    evaluations: (evaluations ?? []) as EvaluationRow[],
    kpis: (kpis ?? []) as KPIRow[],
  };
}

function formatDate(dateStr?: string) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" });
}

function StatusBadge({ status }: { status: EvaluationRow["status"] }) {
  const variants: Record<EvaluationRow["status"], "success" | "warning" | "muted" | "info"> = {
    completed: "success",
    acknowledged: "info",
    pending_review: "warning",
    draft: "muted",
  };
  const labels: Record<EvaluationRow["status"], string> = {
    completed: "Completed",
    acknowledged: "Acknowledged",
    pending_review: "Pending Review",
    draft: "Draft",
  };
  return <Badge tone={variants[status]}>{labels[status]}</Badge>;
}

function scoreColor(score?: number) {
  if (score == null) return "text-ink-dim";
  if (score >= 4.5) return "text-green-400";
  if (score >= 3.5) return "text-teal-400";
  if (score >= 2.5) return "text-amber-400";
  return "text-red-400";
}

export default async function PerformancePage() {
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const { evaluations, kpis } = await loadPerformanceData(profile.org_id);

  const draftCount = evaluations.filter((e) => e.status === "draft").length;
  const pendingCount = evaluations.filter((e) => e.status === "pending_review").length;
  const completedCount = evaluations.filter((e) => e.status === "completed" || e.status === "acknowledged").length;
  const avgScore = evaluations.filter((e) => e.overall_score != null).reduce((a, b) => a + (b.overall_score ?? 0), 0) /
    Math.max(1, evaluations.filter((e) => e.overall_score != null).length);

  return (
    <AppShell breadcrumb={["People", "Performance"]} profile={profile}>
      <PageHeader
        title="Performance Management"
        subtitle={`Evaluations · KPIs · Reports · ${evaluations.length} total cycles`}
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/performance/new"
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              + New Cycle
            </Link>
            <Link
              href="/performance/templates"
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              Templates
            </Link>
            <Link
              href="/performance/reports"
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              Reports
            </Link>
          </div>
        }
      />

      {/* Summary Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Draft" value={String(draftCount)} hint="Not started" />
        <StatTile label="Pending Review" value={String(pendingCount)} hint="Awaiting manager" valueClassName="text-gold-400" />
        <StatTile label="Completed" value={String(completedCount)} hint="Finalized" valueClassName="text-green-400" />
        <StatTile label="Avg Score" value={avgScore ? avgScore.toFixed(1) : "—"} hint="Out of 5.0" valueClassName={scoreColor(avgScore)} />
      </div>

      {/* Evaluations Table */}
      <SectionCard title="Evaluation Cycles" className="mb-6">
        {evaluations.length === 0 ? (
          <p className="text-sm text-ink-muted text-center py-8">No evaluation cycles created yet.</p>
        ) : (
          <TableShell
            columns={["Employee", "Department", "Period", "Status", "Score", "Evaluator", "Due Date", "Actions"]}
          >
            {evaluations.map((e) => (
              <tr key={e.id} className={rowClass}>
                <td className="p-3 font-medium text-ink">{e.employee_name}</td>
                <td className="p-3 text-ink-muted">{e.department}</td>
                <td className="p-3 font-mono text-sm text-ink">{e.period}</td>
                <td className="p-3"><StatusBadge status={e.status} /></td>
                <td className={`p-3 font-mono text-lg ${scoreColor(e.overall_score)}`}>{e.overall_score?.toFixed(1) ?? "—"}</td>
                <td className="p-3 text-ink-muted">{e.evaluator_name ?? "—"}</td>
                <td className="p-3 text-ink-dim font-mono text-xs">{formatDate(e.due_date)}</td>
                <td className="p-3">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/performance/${e.id}`}
                      className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                    >
                      View
                    </Link>
                    {e.status === "draft" && (
                      <Link
                        href={`/performance/${e.id}/edit`}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                      >
                        Edit
                      </Link>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>

      {/* KPIs Table */}
      <SectionCard title="Key Performance Indicators">
        {kpis.length === 0 ? (
          <p className="text-sm text-ink-muted text-center py-8">No KPIs configured. Define KPIs in cycle setup.</p>
        ) : (
          <TableShell
            columns={["Employee", "KPI", "Target", "Actual", "Achievement", "Weight", "Period"]}
          >
            {kpis.slice(0, 50).map((k) => {
              const achievement = k.target > 0 ? ((k.actual / k.target) * 100).toFixed(0) : "—";
              const achNum = k.target > 0 ? (k.actual / k.target) * 100 : 0;
              return (
                <tr key={k.id} className={rowClass}>
                  <td className="p-3 font-medium text-ink">{k.employee_name}</td>
                  <td className="p-3 text-ink-muted">{k.kpi_name}</td>
                  <td className="p-3 font-mono text-sm text-ink">{k.target.toLocaleString()}</td>
                  <td className="p-3 font-mono text-sm text-ink">{k.actual.toLocaleString()}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-charcoal-800 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-teal-500/60"
                          style={{ width: `${Math.min(100, Math.max(0, achNum))}%` }}
                        />
                      </div>
                      <span className="shrink-0 font-mono text-xs text-ink-muted w-[50px] text-right">
                        {achievement}%
                      </span>
                    </div>
                  </td>
                  <td className="p-3 font-mono text-xs text-ink-muted">{k.weight}%</td>
                  <td className="p-3 font-mono text-sm text-ink">{k.period}</td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </SectionCard>

      {/* Reports Section */}
      <SectionCard title="Available Reports" className="mt-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { title: "Department Summary", desc: "Aggregate scores by department", href: "/performance/reports/department" },
            { title: "Individual Report", desc: "Detailed evaluation per employee", href: "/performance/reports/individual" },
            { title: "KPI Trend Analysis", desc: "Performance trends over time", href: "/performance/reports/kpi-trends" },
            { title: "Calibration Matrix", desc: "Score distribution & outliers", href: "/performance/reports/calibration" },
          ].map((r) => (
            <Link key={r.title} href={r.href} className="p-4 rounded-lg bg-charcoal-800/50 border border-charcoal-700 hover:border-teal-500/50 transition-colors">
              <p className="font-medium text-ink">{r.title}</p>
              <p className="text-sm text-ink-muted mt-1">{r.desc}</p>
            </Link>
          ))}
        </div>
      </SectionCard>
    </AppShell>
  );
}