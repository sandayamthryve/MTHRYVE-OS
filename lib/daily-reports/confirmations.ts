// lib/daily-reports/confirmations.ts — the ONE reader that turns submitted daily
// reports into task-completion confirmations for the metrics layer.
//
// A task is "confirmed complete" when it is tagged (confirmed = true) in a
// daily_report whose status is 'submitted'. The confirmation DATE is that
// report's work_date — the day the work was reported done. This is the single
// signal the scorecard's Efficiency reads (replacing the old updated_at proxy),
// so it lives in one place and every metric surface derives from it identically.
//
// Read-only, RLS-scoped by the caller's client. Two small selects joined in JS
// rather than a nested embed, so it works through the loose cast shim the
// metrics modules already use for tables outside the generated types.

// Loose client shim — matches the read-through cast used across the metrics
// layer (Actions / Live / Contracts). Never writes.
type Shim = { from: (t: string) => any };

// task_id → the EARLIEST work_date on which a submitted report confirmed it.
// Earliest wins so re-confirming a task on a later day never pushes its
// completion date past a due date it already met.
export type ConfirmationMap = Map<string, string>;

export async function fetchConfirmedCompletions(db: Shim): Promise<ConfirmationMap> {
  const [reportsRes, tagsRes] = await Promise.all([
    db.from("daily_reports").select("id, work_date").eq("status", "submitted").is("archived_at", null),
    db.from("daily_report_tasks").select("report_id, task_id, confirmed"),
  ]);

  const workDateByReport = new Map<string, string>();
  for (const r of (reportsRes.data ?? []) as { id: string; work_date: string | null }[]) {
    if (r.id && r.work_date) workDateByReport.set(r.id, r.work_date);
  }

  const confirmedAt: ConfirmationMap = new Map();
  for (const t of (tagsRes.data ?? []) as {
    report_id: string;
    task_id: string;
    confirmed: boolean | null;
  }[]) {
    if (t.confirmed !== true) continue;
    const workDate = workDateByReport.get(t.report_id); // only submitted reports
    if (!workDate || !t.task_id) continue;
    const existing = confirmedAt.get(t.task_id);
    if (!existing || workDate < existing) confirmedAt.set(t.task_id, workDate);
  }
  return confirmedAt;
}
