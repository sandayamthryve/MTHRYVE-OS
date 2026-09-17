import type { BadgeTone } from "@/components/ui";

// The Daily Logs online request forms — a single table (public.daily_log_requests)
// backs all six request types. Requesters file their own; a supervisor or
// leadership decides (pending → approved / rejected), and a requester may cancel
// a still-pending request of their own. This module is the shared vocabulary:
// which fields each type carries, and how each type / status renders.

export const REQUEST_TYPES = [
  "leave",
  "overtime",
  "undertime",
  "ooo",
  "rest_day_duty",
  "holiday_duty",
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_LABELS: Record<RequestType, string> = {
  leave: "Leave",
  overtime: "Overtime",
  undertime: "Undertime",
  ooo: "Out of Office",
  rest_day_duty: "Rest Day Duty",
  holiday_duty: "Holiday Duty",
};

export const REQUEST_TONES: Record<RequestType, BadgeTone> = {
  leave: "violet",
  overtime: "teal",
  undertime: "amber",
  ooo: "muted",
  rest_day_duty: "teal",
  holiday_duty: "violet",
};

export const LEAVE_TYPES = ["vacation", "sick", "emergency", "other"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_LABELS: Record<LeaveType, string> = {
  vacation: "Vacation",
  sick: "Sick",
  emergency: "Emergency",
  other: "Other",
};

export const REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_STATUS_TONES: Record<RequestStatus, BadgeTone> = {
  pending: "amber",
  approved: "teal",
  rejected: "red",
  cancelled: "muted",
};

// The full request row as read back from the table (only the columns the module
// uses). Type-specific columns are all nullable — a leave row leaves the
// overtime fields null, and so on.
export type DailyLogRequest = {
  id: string;
  org_id: string;
  user_id: string;
  request_type: RequestType;
  leave_type: string | null;
  work_date: string | null;
  start_time: string | null;
  end_time: string | null;
  time_out: string | null;
  total_hours: number | null;
  duration: string | null;
  purpose: string | null;
  expected_return: string | null;
  reason: string | null;
  remarks: string | null;
  status: RequestStatus;
  approver_id: string | null;
  decided_at: string | null;
  created_at: string;
};

export function isRequestType(s: string): s is RequestType {
  return (REQUEST_TYPES as readonly string[]).includes(s);
}

// A one-line human summary of a request's type-specific payload, used in the
// queue rows so the decision-maker sees the substance without opening anything.
export function requestSummary(r: DailyLogRequest): string {
  switch (r.request_type) {
    case "leave":
      return [
        r.leave_type ? LEAVE_LABELS[r.leave_type as LeaveType] ?? r.leave_type : "Leave",
        r.work_date ? `on ${r.work_date}` : null,
        r.reason ? `— ${r.reason}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "overtime":
      return [
        r.work_date,
        r.start_time && r.end_time ? `${r.start_time}–${r.end_time}` : null,
        r.total_hours != null ? `${r.total_hours}h` : null,
        r.reason ? `— ${r.reason}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "undertime":
      return [
        r.work_date,
        r.time_out ? `out ${r.time_out}` : null,
        r.reason ? `— ${r.reason}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "ooo":
      return [
        r.work_date,
        r.duration ? `(${r.duration})` : null,
        r.purpose ? `— ${r.purpose}` : null,
        r.expected_return ? `· back ${r.expected_return}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "rest_day_duty":
      return [
        r.work_date,
        r.total_hours != null ? `${r.total_hours}h rendered` : null,
        r.reason ? `— ${r.reason}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "holiday_duty":
      return [
        r.work_date ? `holiday worked ${r.work_date}` : null,
        r.total_hours != null ? `${r.total_hours}h rendered` : null,
        r.remarks ? `— ${r.remarks}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    default:
      return "";
  }
}
