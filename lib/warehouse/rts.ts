// Shared vocabulary, labels and small helpers for the RTS (Return to Seller)
// and Case Monitoring modules. Kept in one place so the RTS page, the Case
// Monitoring pages and their server actions read the same fixed strings — the
// stored values are canonical; only the labels are prettied for display.

import type { BadgeTone } from "@/components/ui";

// ── RTS status workflow ───────────────────────────────────────────────────────
// Pending Verification → For Packaging → Ready for Shipment → Shipped →
// Completed. Cancelled is a terminal off-ramp reachable from any stage.
export const RTS_STATUSES = [
  "pending_verification",
  "for_packaging",
  "ready_for_shipment",
  "shipped",
  "completed",
  "cancelled",
] as const;
export type RtsStatus = (typeof RTS_STATUSES)[number];

export const RTS_STATUS_LABEL: Record<RtsStatus, string> = {
  pending_verification: "Pending Verification",
  for_packaging: "For Packaging",
  ready_for_shipment: "Ready for Shipment",
  shipped: "Shipped",
  completed: "Completed",
  cancelled: "Cancelled",
};

// The forward path (excludes cancelled). Used to compute the "next status" the
// workflow allows and to render the progress rail.
export const RTS_FORWARD: RtsStatus[] = [
  "pending_verification",
  "for_packaging",
  "ready_for_shipment",
  "shipped",
  "completed",
];

export function isRtsStatus(v: string): v is RtsStatus {
  return (RTS_STATUSES as readonly string[]).includes(v);
}

// The single next forward status, or null at the end of the rail.
export function nextRtsStatus(s: RtsStatus): RtsStatus | null {
  if (s === "cancelled" || s === "completed") return null;
  const i = RTS_FORWARD.indexOf(s);
  return i >= 0 && i < RTS_FORWARD.length - 1 ? RTS_FORWARD[i + 1] : null;
}

export function rtsStatusTone(s: string | null): BadgeTone {
  switch (s) {
    case "completed":
      return "teal";
    case "shipped":
    case "ready_for_shipment":
      return "violet";
    case "for_packaging":
      return "amber";
    case "cancelled":
      return "red";
    default:
      return "muted";
  }
}

// ── Case Monitoring status workflow ───────────────────────────────────────────
// New → Assigned → Under Investigation → Awaiting Action → In Progress →
// Pending Resolution → Resolved → Closed.
export const CASE_STATUSES = [
  "new",
  "assigned",
  "under_investigation",
  "awaiting_action",
  "in_progress",
  "pending_resolution",
  "resolved",
  "closed",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  new: "New",
  assigned: "Assigned",
  under_investigation: "Under Investigation",
  awaiting_action: "Awaiting Action",
  in_progress: "In Progress",
  pending_resolution: "Pending Resolution",
  resolved: "Resolved",
  closed: "Closed",
};

// Terminal states — a case here is no longer "open".
export const CASE_SETTLED = new Set<CaseStatus>(["resolved", "closed"]);
// Landing in one of these requires leadership (mirrors the DB guard trigger).
export const CASE_LEADERSHIP_ONLY = new Set<CaseStatus>(["resolved", "closed"]);

export function isCaseStatus(v: string): v is CaseStatus {
  return (CASE_STATUSES as readonly string[]).includes(v);
}

export function caseStatusTone(s: string | null): BadgeTone {
  switch (s) {
    case "closed":
    case "resolved":
      return "teal";
    case "pending_resolution":
    case "in_progress":
      return "violet";
    case "awaiting_action":
    case "under_investigation":
      return "amber";
    case "new":
      return "red";
    default:
      return "muted";
  }
}

// ── Priority ──────────────────────────────────────────────────────────────────
export const CASE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_PRIORITY_LABEL: Record<CasePriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export function isCasePriority(v: string): v is CasePriority {
  return (CASE_PRIORITIES as readonly string[]).includes(v);
}

export function priorityTone(p: string | null): BadgeTone {
  switch (p) {
    case "urgent":
      return "red";
    case "high":
      return "amber";
    case "medium":
      return "violet";
    default:
      return "muted";
  }
}

// ── RTS reason vocabulary (shared with the return-case reasons) ───────────────
export const RTS_REASONS: { value: string; label: string }[] = [
  { value: "rts_undelivered", label: "RTS — undelivered / COD refused" },
  { value: "wrong_missing_shortship", label: "Wrong / missing / short-shipped" },
  { value: "damaged_transit", label: "Damaged in transit" },
  { value: "defective_quality", label: "Defective / quality" },
  { value: "change_of_mind", label: "Change of mind" },
  { value: "other", label: "Other" },
];
export const RTS_REASON_LABEL = new Map(RTS_REASONS.map((r) => [r.value, r.label]));
export const RTS_REASON_SET = new Set(RTS_REASONS.map((r) => r.value));

// ── Small formatting helpers ──────────────────────────────────────────────────

// Format a Date as YYYY-MM-DD from its local parts (avoids the UTC drift a
// toISOString() slice would introduce for a midnight-local date).
export function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isDateStr(s?: string | null): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// The YYYY-MM month key for a YYYY-MM-DD date, or null.
export function monthKey(d: string | null): string | null {
  return isDateStr(d) ? (d as string).slice(0, 7) : null;
}

// Whole days from a YYYY-MM-DD date to today (>= 0), local-parsed.
export function daysSince(dateStr: string | null, today: Date): number {
  if (!isDateStr(dateStr)) return 0;
  const [y, m, d] = (dateStr as string).split("-").map(Number);
  const then = new Date(y, m - 1, d);
  return Math.max(0, Math.floor((today.getTime() - then.getTime()) / 86_400_000));
}
