import type { BadgeTone } from "@/components/ui";

// Company-wide Daily Report — the ONE confirmation of task performance.
//
// EVERY role files a daily report (not just HR on the attendance gate): what
// they worked on, the outputs they produced, and any blockers. The report is
// TAGGED to the task(s) it confirms — submitting the report is what marks those
// tasks as genuinely done, and that confirmation is the SINGLE input to the
// scorecard's Efficiency signal (lib/metrics/signals). There is no parallel
// efficiency number: the daily report is the source of truth for "work done".
//
// Storage (live spine, created out-of-band):
//   • daily_reports(id, org_id, user_id, department_id, work_date, summary,
//     outputs, blockers, status['draft'|'submitted'], submitted_at) —
//     UNIQUE per (org_id, user_id, work_date).
//   • daily_report_tasks(report_id → daily_reports, task_id, confirmed) —
//     the tags; a submitted report with confirmed=true confirms the task.
//   • evidence_attachments(entity_type='daily_report', entity_id=report_id) —
//     Evidence (2.1) hangs off the report through the existing capture spine.
//
// This module is the shared vocabulary — the row shapes and how each status
// renders — so the UI, the server action, and the metrics layer never drift.

export const REPORT_STATUSES = ["draft", "submitted"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
};

export const REPORT_STATUS_TONES: Record<ReportStatus, BadgeTone> = {
  draft: "amber",
  submitted: "teal",
};

// A daily_reports row as read back (only the columns this app touches).
export type DailyReport = {
  id: string;
  org_id: string;
  user_id: string;
  department_id: string | null;
  work_date: string;
  summary: string | null;
  outputs: string | null;
  blockers: string | null;
  status: ReportStatus;
  submitted_at: string | null;
  created_at: string;
};

// A tag linking a report to a task it confirms.
export type DailyReportTask = {
  report_id: string;
  task_id: string;
  confirmed: boolean;
};

export function isReportStatus(s: string): s is ReportStatus {
  return (REPORT_STATUSES as readonly string[]).includes(s);
}
