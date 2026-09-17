// lib/notifications/read.ts — the read side of the per-user notification layer:
// the centre's list, the unread badge count, and the type→presentation map.
//
// Every read goes through the caller's RLS user client, so a person sees only
// the notifications RLS lets them SELECT (their own, plus everything for
// leadership). This module never uses the service-role key — the badge and the
// centre must reflect exactly what the signed-in user is allowed to see.

import type { BadgeTone } from "@/components/ui";
import type { NotificationSeverity, NotificationType } from "@/lib/notifications/notify";

export interface NotificationRow {
  id: string;
  type: NotificationType | string;
  title: string;
  body: string | null;
  severity: NotificationSeverity | string;
  entity_type: string | null;
  entity_id: string | null;
  read: boolean;
  created_at: string;
}

type Shim = { from: (t: string) => any };

// Newest-first page of the caller's OWN notifications. RLS lets leadership read
// the whole org's, but the centre is a personal inbox — so we always scope to
// the signed-in user's id. (Leadership's org-wide read stays available for a
// future oversight view; the default surface is "yours".)
export async function listNotifications(db: Shim, userId: string, limit = 50): Promise<NotificationRow[]> {
  try {
    const { data } = await db
      .from("notifications")
      .select("id, type, title, body, severity, entity_type, entity_id, read, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    return ((data as NotificationRow[] | null) ?? []).map((r) => ({ ...r, read: !!r.read }));
  } catch {
    return [];
  }
}

// The caller's OWN unread count for the header bell badge. Scoped to the user so
// a CEO's badge reflects their inbox, not the whole org. Degrades to 0, never
// throws (so a transient read error never blanks the shell).
export async function unreadNotificationCount(db: Shim, userId: string): Promise<number> {
  try {
    const { count } = await db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("read", false);
    return count ?? 0;
  } catch {
    return 0;
  }
}

// ── Presentation ──────────────────────────────────────────────────────────────
export const SEVERITY_TONE: Record<string, BadgeTone> = {
  critical: "red",
  warning: "amber",
  info: "teal",
};

export const TYPE_LABEL: Record<string, string> = {
  stockout_risk: "Stockout risk",
  metric_mismatch: "Metric mismatch",
  overdue_task: "Overdue task",
  overdue_case: "Overdue case",
  pending_approval: "Pending approval",
  sla_breach: "SLA breach",
  morning_digest: "Morning briefing",
  daily_tap: "Daily Tap",
  task_tag: "Tagged on a task",
  task_covered: "Task covered",
  governed_delete: "Permanent delete",
  probation_decision: "Probation decision",
  probation_review_due: "Probation review due",
  weekly_scoreboard: "Growth Scoreboard",
  approval_escalation: "Approval nudge",
  approval_outcome: "Request outcome",
};

export function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, " ");
}

// Where a notification's "View" link should land, from its entity pointer. An
// action_request opens the Approval Queue; the rest deep-link to their module.
export function notificationHref(row: Pick<NotificationRow, "type" | "entity_type" | "entity_id">): string {
  switch (row.entity_type) {
    case "action_request":
      return "/approvals";
    case "task":
      return "/tasks";
    case "case":
      return row.entity_id ? `/warehouse/cases/${row.entity_id}` : "/warehouse/cases";
    case "product":
      return "/warehouse/intelligence";
    case "daily_tap":
      return "/daily-tap";
    default:
      break;
  }
  // Fall back by type when there's no entity pointer (or the pointer is a
  // 'user', which routes by type: HR review-due lands on the queue, a decision
  // notice lands on the roster both recipients can see).
  if (row.type === "probation_review_due") return "/people/probation";
  if (row.type === "probation_decision") return "/people";
  if (row.type === "pending_approval") return "/approvals";
  if (row.type === "approval_escalation") return "/approvals";
  if (row.type === "approval_outcome") return "/approvals";
  if (row.type === "weekly_scoreboard") return "/scoreboard";
  if (row.type === "morning_digest") return "/";
  if (row.type === "daily_tap") return "/daily-tap";
  return "/notifications";
}

// A pending_approval notification that points at a real action_request is the
// only kind that offers an in-line Approve — and only through the spine.
export function canApproveInline(
  row: Pick<NotificationRow, "type" | "entity_type" | "entity_id">
): boolean {
  return row.type === "pending_approval" && row.entity_type === "action_request" && !!row.entity_id;
}
