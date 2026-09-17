import { AppShell } from "@/components/layout/AppShell";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, Card } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { AutomationRadar } from "@/components/automation-radar/AutomationRadar";
import { QuickEntryLauncher } from "@/components/quick-entry/QuickEntryLauncher";
import { DailyReportCard } from "@/components/daily-reports/DailyReportCard";

// Personal workspace for every authenticated user. Real assigned-task content
// lands in Milestone 3; for now it confirms the signed-in identity and the
// user's department resolve correctly end to end.
export default async function EmployeeDashboardPage() {
  const profile = await requireProfile();

  let departmentName: string | null = null;
  if (profile.department_id) {
    const supabase = createServerSupabaseClient();
    const { data } = await supabase
      .from("departments")
      .select("name")
      .eq("id", profile.department_id)
      .single();
    // Explicit cast avoids the @supabase/ssr select-inference `never` quirk.
    departmentName = (data as { name: string } | null)?.name ?? null;
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "My dashboard"]} profile={profile}>
      <PageHeader
        title={`Welcome, ${profile.full_name.split(" ")[0]}`}
        subtitle={
          <>
            {departmentName ? `${departmentName} · ` : ""}Your assigned tasks will appear here once Task
            Management ships (Milestone 3).
          </>
        }
      />

      {/* Company-wide Daily Report: every role files one from their role home.
          Filing confirms the tagged tasks — the single input to Efficiency. */}
      <div className="mb-6">
        <DailyReportCard />
      </div>

      {/* Mobile quick-entry: snap a photo/screenshot of a number → confirm → save,
          with the capture stored as evidence. Launchable from every role home. */}
      <div className="mb-6">
        <QuickEntryLauncher />
      </div>

      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="My open tasks" value="—" hint="Milestone 3" />
        <StatCard label="Due this week" value="—" hint="Milestone 3" accent="gold" />
        <StatCard label="Completed" value="—" hint="Milestone 3" accent="green" />
      </div>

      {/* Automation Radar for the member's own department — the SAME component used
          org-wide and in every department tab, filtered to their team. Members can
          propose or dismiss their own patterns (RLS-scoped). */}
      {departmentName && (
        <section className="mb-8">
          <AutomationRadar department={departmentName} title="Automation Radar · Your team" />
        </section>
      )}

      <Card className="text-sm text-ink-muted">
        No tasks yet — this view confirms auth, profile resolution, and routing work end to end.
      </Card>
    </AppShell>
  );
}
