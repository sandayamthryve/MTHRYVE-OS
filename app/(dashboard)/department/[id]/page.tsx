import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, Card, SectionCard } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { AutomationRadar } from "@/components/automation-radar/AutomationRadar";
import { QuickEntryLauncher } from "@/components/quick-entry/QuickEntryLauncher";
import { DailyReportCard } from "@/components/daily-reports/DailyReportCard";
import { ContributorReportsCard } from "@/components/daily-reports/ContributorReportsCard";
import { computeDepartmentEfficiency } from "@/lib/metrics/signals";
import {
  getCreativePerformance,
  currentMonth,
  formatPct,
  formatCost,
} from "@/lib/content/performance";

// Department-scoped view. Access rules (RBAC per PROJECT.md):
//   - CEO / COO: any department in the org
//   - Department Head: only their own department (redirected if they try another)
//   - Team Member: not a department landing page — sent to their personal view
export default async function DepartmentDashboardPage({
  params,
}: {
  params: { id: string };
}) {
  const profile = await requireProfile();

  if (profile.role === "team_member") redirect("/employee");
  if (profile.role === "department_head" && profile.department_id !== params.id) {
    redirect(profile.department_id ? `/department/${profile.department_id}` : "/employee");
  }

  const supabase = createServerSupabaseClient();
  const { data: departmentRow } = await supabase
    .from("departments")
    .select("id, name")
    .eq("id", params.id)
    .single();

  // RLS scopes to the caller's org, so a missing row means "not in your org or
  // doesn't exist" — either way, a 404 is the honest answer. Explicit typing
  // avoids the @supabase/ssr select-inference never quirk (see CEO page note).
  const department = departmentRow as { id: string; name: string } | null;
  if (!department) notFound();

  const { count: memberCount } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("department_id", department.id);

  // Latest recorded metrics for this department (universal metric set, D-004).
  const { data: metricData } = await supabase
    .from("metrics_snapshots")
    .select("efficiency, quality_score, capacity_utilization")
    .eq("department_id", department.id)
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  const metric = metricData as {
    efficiency: number;
    quality_score: number;
    capacity_utilization: number;
  } | null;
  const show = (v: number | undefined) => (v == null ? "—" : String(Number(v)));

  // Efficiency is the confirmed daily-report signal (not the recorded snapshot) —
  // the single source of truth, honest "—" when this department has no confirmed
  // completions yet.
  const deptEfficiency = (await computeDepartmentEfficiency(supabase)).get(department.id) ?? null;
  const efficiencyDisplay =
    deptEfficiency && deptEfficiency.value != null ? String(deptEfficiency.value) : "—";

  return (
    <AppShell breadcrumb={["Mthryve OS", "Departments", department.name]} profile={profile}>
      <PageHeader title={department.name} subtitle="Department workspace." />

      {/* Company-wide Daily Report: every role files one from their role home. */}
      <div className="mb-6">
        <DailyReportCard />
      </div>

      {/* Mobile quick-entry: snap a photo/screenshot of a number → confirm → save,
          with the capture stored as evidence. Launchable from every role home. */}
      <div className="mb-6">
        <QuickEntryLauncher />
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Team members" value={memberCount ?? 0} />
        <StatCard label="Efficiency" value={efficiencyDisplay} accent="green" />
        <StatCard label="Quality score" value={show(metric?.quality_score)} accent="gold" />
        <StatCard label="Capacity" value={show(metric?.capacity_utilization)} />
      </div>

      {/* Creative-specific summary tile — the department scorecard surfaces this
          month's creative output (published / on-time / in-production / cost) and
          links to the full Performance view. Only for the Creative department; a
          read-only roll-up of the same content records. */}
      {department.name.trim().toLowerCase().includes("creative") && (
        <CreativeScorecardTile viewerId={profile.id} />
      )}

      {/* Contributor / intern daily reports for this department — hosts and interns
          file through their /host link; their reports land here labeled as such. */}
      <ContributorReportsCard departmentId={department.id} />

      {/* Automation Radar — the SAME reusable component used org-wide, filtered
          to THIS department. One detector, a per-team view: ranked repeated work
          with an honest classification; "Propose" files a pending action_request. */}
      <section className="mb-8">
        <AutomationRadar department={department.name} />
      </section>

      <Card className="text-sm text-ink-muted">
        Metrics reflect the latest recorded snapshot for this department (Reports → Record metrics).
        Task views are on the Tasks board.
      </Card>
    </AppShell>
  );
}

// Compact creative-output roll-up for the Creative department scorecard. Reuses
// the same read-only aggregation as the Creative Studio → Performance tab, over
// the current month, org-wide (this page is leadership-only, so the viewer sees
// all). Honest empty state when the studio has no activity yet.
async function CreativeScorecardTile({ viewerId }: { viewerId: string }) {
  const supabase = createServerSupabaseClient();
  const month = currentMonth();
  const perf = await getCreativePerformance(supabase, {
    month,
    brandId: null,
    viewerId,
    canSeeAll: true,
  });
  const o = perf.overall;

  return (
    <section className="mb-8">
      <SectionCard
        title="Creative output"
        icon="🎬"
        action={
          <Link
            href="/creative-studio?tab=performance"
            className="text-xs font-medium text-teal-300 hover:text-teal-200"
          >
            Full performance →
          </Link>
        }
      >
        {!perf.hasAnyData ? (
          <p className="text-sm text-ink-muted">
            No content produced, published, or in production yet this month ({perf.monthLabel}). As
            the team works pieces through the Creative Studio pipeline, this month&rsquo;s roll-up
            appears here.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard label="Published" value={o.published} accent="green" />
              <StatCard label="On-time" value={formatPct(o.onTimeRate)} />
              <StatCard label="In production" value={o.inProduction} accent="gold" />
              <StatCard label="Cost" value={formatCost(o.costUsd)} />
            </div>
            <p className="mt-3 text-xs text-ink-muted">
              {perf.monthLabel}: {o.produced} produced · {o.scheduled} scheduled ·{" "}
              {o.overdue > 0 ? `${o.overdue} overdue` : "none overdue"}.
            </p>
          </>
        )}
      </SectionCard>
    </section>
  );
}
