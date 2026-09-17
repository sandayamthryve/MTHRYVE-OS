import type { DailyLogRequest } from "@/lib/hr/requests";
import { attendanceCredit } from "@/lib/hr/status";

// Shared roll-up used by the Daily Logs Monthly Summary and by Payroll, so both
// count the same way. Attendance columns (late / undertime / total hours) are
// read straight off the row — they're computed at punch time — while OVERTIME,
// Approved Leave, Holiday Duty and Rest Day Duty come only from APPROVED
// daily_log_requests. That keeps a single authority for each number: the punch
// for time worked, the approved request for everything that needs a decision.

export type AttendanceLite = {
  user_id: string;
  work_date: string;
  status: string | null;
  clock_in: string | null;
  clock_out: string | null;
  late_minutes: number | null;
  undertime_minutes: number | null;
  total_hours: number | null;
  report_submitted: boolean | null;
  report_id: string | null;
};

export type ContractorSummary = {
  workingDays: number; // attendance credit (present/late/remote = 1, half = 0.5)
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  remote: number;
  lateMinutes: number;
  undertimeMinutes: number;
  overtimeMinutes: number; // approved overtime requests only
  totalHours: number;
  approvedLeaveDays: number;
  holidayDutyDays: number;
  restDayDutyDays: number;
};

function empty(): ContractorSummary {
  return {
    workingDays: 0,
    present: 0,
    late: 0,
    halfDay: 0,
    absent: 0,
    onLeave: 0,
    remote: 0,
    lateMinutes: 0,
    undertimeMinutes: 0,
    overtimeMinutes: 0,
    totalHours: 0,
    approvedLeaveDays: 0,
    holidayDutyDays: 0,
    restDayDutyDays: 0,
  };
}

// Build a per-user summary. `attendance` and `requests` should already be scoped
// to the period of interest; `userIds` seeds a zero row for everyone so the
// output is complete (honest empties for people with no activity).
export function summarize(
  userIds: string[],
  attendance: AttendanceLite[],
  requests: DailyLogRequest[]
): Map<string, ContractorSummary> {
  const out = new Map<string, ContractorSummary>();
  for (const id of userIds) out.set(id, empty());

  const bump = (id: string): ContractorSummary => {
    let s = out.get(id);
    if (!s) {
      s = empty();
      out.set(id, s);
    }
    return s;
  };

  for (const a of attendance) {
    const s = bump(a.user_id);
    s.workingDays += attendanceCredit(a.status);
    if (a.status === "present") s.present += 1;
    else if (a.status === "late") s.late += 1;
    else if (a.status === "half_day") s.halfDay += 1;
    else if (a.status === "absent") s.absent += 1;
    else if (a.status === "on_leave") s.onLeave += 1;
    else if (a.status === "working_remotely") s.remote += 1;
    s.lateMinutes += Number(a.late_minutes ?? 0);
    s.undertimeMinutes += Number(a.undertime_minutes ?? 0);
    s.totalHours += Number(a.total_hours ?? 0);
  }

  for (const r of requests) {
    if (r.status !== "approved") continue;
    const s = bump(r.user_id);
    if (r.request_type === "overtime") {
      s.overtimeMinutes += Math.round(Number(r.total_hours ?? 0) * 60);
    } else if (r.request_type === "leave") {
      s.approvedLeaveDays += 1;
    } else if (r.request_type === "holiday_duty") {
      s.holidayDutyDays += 1;
    } else if (r.request_type === "rest_day_duty") {
      s.restDayDutyDays += 1;
    }
  }

  // Round the accumulated hours once, at the end.
  for (const s of out.values()) {
    s.totalHours = Math.round(s.totalHours * 100) / 100;
  }
  return out;
}
