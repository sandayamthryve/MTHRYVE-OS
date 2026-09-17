import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadMyDay } from "@/lib/home/cockpit";
import { MyDayView } from "@/components/home/cockpit-views";
import { QuickEntryLauncher } from "@/components/quick-entry/QuickEntryLauncher";
import { SubmitReportForm } from "@/components/daily-logs/SubmitReportForm";

// My Day — the team_member cockpit, scoped entirely to the signed-in person:
// today's tasks · their Daily Report (with the mobile Quick-Entry / evidence
// capture) · their department's key metrics · a mini-Tony slot. Any role may open
// their own My Day; the /home dispatcher sends team_members here on login.
export const dynamic = "force-dynamic";

export default async function MyDayPage() {
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const supabase = createServerSupabaseClient();
  const data = await loadMyDay(supabase, {
    userId: profile.id,
    departmentId: profile.department_id,
  });

  return (
    <AppShell breadcrumb={["Mthryve OS", "My Day"]} profile={profile}>
      <PageHeader
        title={`Good to see you, ${profile.full_name.split(" ")[0]}`}
        subtitle="Your day at a glance — tasks, your daily report, and how your department is tracking."
      />

      <MyDayView
        data={data}
        // Mobile quick-entry / evidence capture — present on every role home,
        // prefilled to this person's department metrics slice.
        captureSlot={
          <div className="mb-6">
            <QuickEntryLauncher defaultDepartment={data.metricsDepartment} />
          </div>
        }
        // The daily-report write control (client). The read-only status renders
        // above it inside MyDayView.
        reportSlot={
          <div className="mt-3">
            <SubmitReportForm today={data.report.workDate} alreadySubmitted={data.report.filedToday} />
          </div>
        }
      />
    </AppShell>
  );
}
