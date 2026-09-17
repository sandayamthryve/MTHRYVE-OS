import type { BadgeTone } from "@/components/ui";
import type { DailyLogRequest } from "@/lib/hr/requests";

// attendance.status is a free-text column, so the Daily Logs module can widen
// the vocabulary without a schema change. These are the values a contractor can
// set on their own day; OOO / Rest Day / Holiday Duty are *derived* from
// approved requests rather than self-set, so they aren't in this list.

export const DAY_STATUSES = [
  "present",
  "late",
  "half_day",
  "absent",
  "on_leave",
  "working_remotely",
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const DAY_STATUS_LABELS: Record<DayStatus, string> = {
  present: "Present",
  late: "Late",
  half_day: "Half day",
  absent: "Absent",
  on_leave: "On leave",
  working_remotely: "Working remotely",
};

export const DAY_STATUS_TONES: Record<DayStatus, BadgeTone> = {
  present: "teal",
  late: "amber",
  half_day: "violet",
  absent: "red",
  on_leave: "muted",
  working_remotely: "teal",
};

export function isDayStatus(s: string): s is DayStatus {
  return (DAY_STATUSES as readonly string[]).includes(s);
}

// Attendance credit toward days present: a full worked day (present / late /
// remote) counts 1, a half day 0.5, everything else 0. Overtime and leave are
// tracked separately — this is only the "did they put in the day" signal.
export function attendanceCredit(status: string | null): number {
  if (status === "present" || status === "late" || status === "working_remotely") return 1;
  if (status === "half_day") return 0.5;
  return 0;
}

// The label for any status string (widened statuses fall back to a title-cased
// version so an unknown value still reads cleanly).
export function statusLabel(status: string | null): string {
  if (!status) return "No record";
  if (status in DAY_STATUS_LABELS) return DAY_STATUS_LABELS[status as DayStatus];
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function statusTone(status: string | null): BadgeTone {
  if (status && status in DAY_STATUS_TONES) return DAY_STATUS_TONES[status as DayStatus];
  return "muted";
}

// The eight buckets of the Contractor Status Overview. "active" is the roster
// total; the rest are today's effective states.
export type OverviewKey =
  | "active"
  | "logged_in"
  | "absent"
  | "on_leave"
  | "ooo"
  | "rest_day"
  | "holiday_duty"
  | "working_remotely";

// Map an approved request to the overview bucket it implies for its work_date.
export function requestOverviewKey(r: DailyLogRequest): OverviewKey | null {
  switch (r.request_type) {
    case "leave":
      return "on_leave";
    case "ooo":
      return "ooo";
    case "rest_day_duty":
      return "rest_day";
    case "holiday_duty":
      return "holiday_duty";
    default:
      return null; // overtime / undertime don't change the day bucket
  }
}
