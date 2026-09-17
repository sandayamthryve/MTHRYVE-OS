import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manilaToday } from "@/lib/hr/time";
import { DailyReportLauncher, type TaggableTask } from "./DailyReportLauncher";

// Server wrapper for the company-wide Daily Report entry point, dropped onto
// every role home (Command Center, Department, My workspace). It loads exactly
// what the launcher needs — the filer's own tasks to tag, and today's report if
// one already exists (so the form pre-fills and a resubmit replaces) — then
// hands off to the client modal. RLS scopes every read to the caller.
export async function DailyReportCard() {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const today = manilaToday();
  const db = supabase as unknown as { from: (t: string) => any };

  const [tasksRes, reportRes] = await Promise.all([
    // The filer's own tasks — the ones a daily report can confirm. Cancelled work
    // is excluded; everything else is taggable (done tasks stay listed so a report
    // can confirm them). Newest activity first.
    supabase
      .from("tasks")
      .select("id, title, status, due_date")
      .eq("assignee_id", profile.id)
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(60),
    db
      .from("daily_reports")
      .select("id, outputs, summary, blockers, status")
      .eq("user_id", profile.id)
      .eq("work_date", today)
      .is("archived_at", null)
      .maybeSingle(),
  ]);

  const tasks = ((tasksRes.data ?? []) as TaggableTask[]) ?? [];
  const existing = (reportRes.data ?? null) as {
    id: string;
    outputs: string | null;
    summary: string | null;
    blockers: string | null;
    status: string;
  } | null;

  // Which of today's tasks are already confirmed on today's report (pre-check).
  let taggedIds: string[] = [];
  if (existing?.id) {
    const { data: tags } = await db
      .from("daily_report_tasks")
      .select("task_id, confirmed")
      .eq("report_id", existing.id);
    taggedIds = ((tags ?? []) as { task_id: string; confirmed: boolean | null }[])
      .filter((t) => t.confirmed)
      .map((t) => t.task_id);
  }

  return (
    <DailyReportLauncher
      today={today}
      tasks={tasks}
      existing={
        existing
          ? {
              outputs: existing.outputs,
              summary: existing.summary,
              blockers: existing.blockers,
              submitted: existing.status === "submitted",
              taggedIds,
            }
          : null
      }
    />
  );
}
