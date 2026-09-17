// lib/notifications/notify.ts — the ONE place the OS writes a per-user
// notification (public.notifications), plus the role→recipient matrix the
// producers fan out through.
//
// This is the PER-USER layer that sits ON TOP of the older org-level
// public.events feed. events answers "what happened in the org"; notifications
// answers "what does THIS person need to see". Both stay: producers may write
// an org event AND fan a notification to the right people.
//
// GOVERNING RULES (mirror the rest of the OS):
//   • RLS on notifications: recipient + leadership may SELECT, recipient may
//     UPDATE (mark read), org members may INSERT. Producers run as the SYSTEM
//     through the service-role client so a scan/cron with no user session (and a
//     fan-out to OTHER users) still writes reliably — org_id is always stamped
//     from a VERIFIED profile or the org loop, never from client input.
//   • Nothing here executes anything. A notification is a pointer to a real row
//     (entity_type + entity_id); any action it offers routes through the
//     approval spine / policy_registry (see lib/notifications/producers.ts and
//     the notification centre), never auto-runs.
//   • Best-effort: a failed notification never takes down the action it
//     describes. Every writer swallows its own errors.
//
// notifications isn't in the generated Database types yet, so — like the rest of
// the action spine — it's reached through the app's cast shim.

import { createServiceRoleClient } from "@/lib/supabase/service";

export type Shim = { from: (t: string) => any };

// The kinds of thing the OS proactively tells a person about. Keep in sync with
// the producers below; the UI groups + labels by this.
export type NotificationType =
  | "stockout_risk"
  | "metric_mismatch"
  | "overdue_task"
  | "overdue_case"
  | "pending_approval"
  | "sla_breach"
  | "morning_digest"
  // The Daily AI Tap — a per-user morning brief (see lib/daily-tap).
  | "daily_tap"
  // Snap-Tag — a leadership/head tagged this person onto a task (see
  // lib/tasks/snap-tag). Points at the task row; the bell is one of three
  // best-effort channels (bell + email + one Telegram group broadcast).
  | "task_tag"
  // Head Cover Mode — a department head / leadership acted on this person's task
  // on their behalf while they were out (reassigned it, changed its status, or
  // marked it complete). Points at the task row (see lib/tasks/coverage).
  | "task_covered"
  // Budget monitoring (fired to CEO + COO): a budget crossed 80% / 90% / over.
  | "budget_threshold"
  // Expense hygiene (fired to CEO + COO): no supporting reference on file, or a
  // reference_number already used by another expense.
  | "expense_missing_doc"
  | "duplicate_reference"
  // Governed permanent-delete (see lib/governance): fired to the current-stage
  // officer when a delete needs their decision, and to the requester when the
  // chain finishes (executed or rejected). Points at the action_request so the
  // bell deep-links to Approvals.
  | "governed_delete"
  // New-hire probation lifecycle (see lib/people/probation). A decision
  // (regularize / extend / release) fans to the hire's supervisor + the hire;
  // the daily auto-flag tells HR about hires hitting the 14-day review window.
  | "probation_decision"
  | "probation_review_due"
  // Sync health (fired to CEO + COO): the TikTok Shop daily sync's last
  // scheduled run is missing/stale or classified failed, or a connection's
  // access token expires within 48h. Bell + one Telegram broadcast, idempotent
  // to one alert per incident per day (see lib/tiktok/health + producers).
  | "sync_health_alert"
  // Auth health (fired to CEO + COO): the production synthetic monitor
  // (/api/monitor/auth-health, Vercel Cron) saw the live /login screen unhealthy —
  // a redirect (loop signature), a 429, a non-200, or a missing sign-in marker.
  // Points at the system_health_checks row. This is the production heartbeat that
  // makes auto-promote safe; a failed check is NEVER silently swallowed.
  | "auth_health_alert"
  // Weekly Growth Scoreboard (fired to leadership by the Monday cron,
  // /api/automation/scoreboard): the org's top-line playbook KPIs for the window,
  // computed live from the scoreboard engine — same numbers as /scoreboard.
  // Honest em-dashes for anything not yet measurable; points at /scoreboard.
  | "weekly_scoreboard"
  // Approval escalation (daily sweep, /api/automation/approval-sweep): an
  // action_request has sat pending past APPROVAL_ESCALATION_HOURS without a
  // decision. Re-pings exactly the roles that may decide it. Completes the
  // documented Approval Routing agent: route → notify → escalate → report back.
  | "approval_escalation"
  // Approval outcome report-back (same sweep): a request the USER FILED was
  // decided (approved / executed / rejected / failed / expired / cancelled) in
  // the last 24h. Closes the loop with the requester automatically instead of
  // relying on them re-checking the queue. Points at the action_request.
  | "approval_outcome";

export type NotificationSeverity = "info" | "warning" | "critical";

// The role fan-out targets. A producer either names explicit recipient user ids
// (e.g. a task's assignee) or a set of roles to resolve within the org.
export type OrgRole = "ceo" | "coo" | "department_head" | "team_member";

// Leadership — the set that may read every notification (RLS) and approve the
// highest-tier requests. Reused as the default oversight audience.
export const LEADERSHIP: OrgRole[] = ["ceo", "coo"];

export interface NotifyInput {
  orgId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  severity?: NotificationSeverity; // defaults to 'info' (DB default too)
  entityType?: string | null; // the table/kind the notification points at
  entityId?: string | null; // the row id, so the centre can deep-link + act
  // Recipients: any combination. Explicit user ids AND/OR roles-to-resolve.
  userIds?: string[];
  roles?: OrgRole[];
  // Best-effort de-dupe: skip a recipient who already has an UNREAD notification
  // of this (type, entityId) within `withinHours` (default 20h ≈ once/day). This
  // is what keeps a daily overdue scan or the morning digest from stacking.
  dedupeWithinHours?: number | null;
}

// Resolve the user ids in an org holding any of `roles`. Org-scoped explicitly
// even though the service-role client bypasses RLS — intent stays obvious and a
// stray query can never leak across orgs.
export async function resolveRoleRecipients(
  db: Shim,
  orgId: string,
  roles: OrgRole[]
): Promise<string[]> {
  if (roles.length === 0) return [];
  try {
    const { data } = await db
      .from("users")
      .select("id")
      .eq("org_id", orgId)
      .in("role", roles);
    return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
  } catch {
    return [];
  }
}

// Insert one notification per recipient. Fans out to the union of explicit
// userIds and role-resolved ids (de-duplicated), honours the optional unread
// de-dupe window, and never throws. Returns how many rows were written.
export async function notify(input: NotifyInput, client?: Shim): Promise<number> {
  const db = client ?? (createServiceRoleClient() as unknown as Shim);
  try {
    const roleIds = input.roles?.length
      ? await resolveRoleRecipients(db, input.orgId, input.roles)
      : [];
    const recipients = Array.from(
      new Set([...(input.userIds ?? []), ...roleIds].filter((id): id is string => !!id))
    );
    if (recipients.length === 0) return 0;

    // De-dupe against still-unread notifications for the same (type, entity).
    let skip = new Set<string>();
    const withinHours = input.dedupeWithinHours ?? null;
    if (withinHours && input.entityId) {
      const since = new Date(Date.now() - withinHours * 3600_000).toISOString();
      try {
        const { data } = await db
          .from("notifications")
          .select("user_id")
          .eq("org_id", input.orgId)
          .eq("type", input.type)
          .eq("entity_id", input.entityId)
          .eq("read", false)
          .gte("created_at", since)
          .in("user_id", recipients);
        skip = new Set(((data as Array<{ user_id: string }> | null) ?? []).map((r) => r.user_id));
      } catch {
        // A failed de-dupe read must not block the notification.
      }
    }

    const rows = recipients
      .filter((uid) => !skip.has(uid))
      .map((uid) => ({
        org_id: input.orgId,
        user_id: uid,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        severity: input.severity ?? "info",
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
      }));
    if (rows.length === 0) return 0;

    await db.from("notifications").insert(rows);
    return rows.length;
  } catch {
    // A notification is a courtesy, never a gate — its failure is swallowed.
    return 0;
  }
}
