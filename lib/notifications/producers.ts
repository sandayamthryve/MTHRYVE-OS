// lib/notifications/producers.ts — the typed producers the OS's real flows call
// to notify the RIGHT people when a real event happens. Each is a thin, named
// wrapper over notify() that encodes the role→recipient MATRIX for that event
// and points the notification at the real row (entity_type + entity_id) so the
// notification centre can deep-link and offer a gated action.
//
// Every producer is GROUNDED: it takes facts already read from real rows by its
// caller (a stock scan, a mismatch escalation, an overdue sweep) — it never
// invents a number and never runs on a hypothetical. And every producer is
// best-effort: notify() swallows its own errors so a courtesy notification can
// never break the action it accompanies.
//
// THE MATRIX (who hears about what):
//   stockout_risk    → leadership + department heads (ops owners)
//   metric_mismatch  → leadership (the number isn't trusted until reconciled)
//   pending_approval → whoever RLS lets DECIDE the request (by required_role)
//   overdue_task     → the assignee (fallback: leadership + heads if unassigned)
//   overdue_case     → the assigned owner + leadership oversight
//   sla_breach       → the assigned owner + leadership oversight
//
// Nothing here executes anything. A pending_approval notification points at an
// action_request the human still has to approve through the spine.

import type { OrgRole, Shim } from "@/lib/notifications/notify";
import { notify } from "@/lib/notifications/notify";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { sendTelegram, escapeHtml } from "@/lib/telegram";
import { peso } from "@/lib/metrics/format";
import { BUDGET_BAND_LABEL, type BudgetBand } from "@/lib/finance/budgets";
import type { OutcomeKind } from "@/lib/automation/approval-sweep";
import { OUTCOME_LABEL, outcomeSeverity } from "@/lib/automation/approval-sweep";

// required_role on an action_request → the roles RLS lets decide it. 'coo'/'ceo'
// requests are leadership-only; a 'department_head' request additionally lets a
// head approve. Mirrors canDecide() in lib/actions/types.ts.
export function approverRoles(requiredRole: string | null | undefined): OrgRole[] {
  return requiredRole === "department_head"
    ? ["ceo", "coo", "department_head"]
    : ["ceo", "coo"];
}

// ── Stockout risk ─────────────────────────────────────────────────────────────
// Fired when the warehouse scan routes a product to REPLENISH (velocity says it
// will stock out). Points at the drafted action_request so the centre can open
// the approval.
export async function notifyStockoutRisk(
  args: {
    orgId: string;
    productLabel: string;
    detail?: string | null;
    actionRequestId?: string | null;
  },
  client?: Shim
): Promise<number> {
  return notify(
    {
      orgId: args.orgId,
      type: "stockout_risk",
      severity: "warning",
      title: `Stockout risk · ${args.productLabel}`,
      body:
        args.detail ??
        "Sales velocity projects this SKU runs out before the next restock. A replenishment is drafted for approval.",
      entityType: args.actionRequestId ? "action_request" : "product",
      entityId: args.actionRequestId ?? null,
      roles: ["ceo", "coo", "department_head"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Metric mismatch ───────────────────────────────────────────────────────────
// Fired when reconciliation opens a mismatch (|variance| over threshold). Points
// at the reconciliation action_request; leadership owns the trust decision.
export async function notifyMetricMismatch(
  args: {
    orgId: string;
    metricLabel: string;
    variancePct: number | null;
    period?: string | null;
    actionRequestId?: string | null;
  },
  client?: Shim
): Promise<number> {
  const v = args.variancePct == null ? "" : ` (${args.variancePct}%)`;
  return notify(
    {
      orgId: args.orgId,
      type: "metric_mismatch",
      severity: "warning",
      title: `Metric mismatch · ${args.metricLabel}${v}`,
      body:
        `The manual and platform figures disagree${args.period ? ` for ${args.period}` : ""}. ` +
        `Reconcile before the number is trusted.`,
      entityType: "action_request",
      entityId: args.actionRequestId ?? null,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Pending approval ──────────────────────────────────────────────────────────
// Fired when a producer drafts an action_request. Notifies exactly the roles RLS
// lets decide it, and points at the request so the centre offers Approve/View.
export async function notifyPendingApproval(
  args: {
    orgId: string;
    title: string;
    body?: string | null;
    requiredRole?: string | null;
    actionRequestId: string;
    severity?: "info" | "warning" | "critical";
  },
  client?: Shim
): Promise<number> {
  return notify(
    {
      orgId: args.orgId,
      type: "pending_approval",
      severity: args.severity ?? "info",
      title: args.title,
      body: args.body ?? "A request is waiting for your decision in the Approval Queue.",
      entityType: "action_request",
      entityId: args.actionRequestId,
      roles: approverRoles(args.requiredRole),
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Overdue task ──────────────────────────────────────────────────────────────
// Fired by the overdue sweep for a task past its due date and not done. The
// assignee hears first; an unassigned task escalates to leadership + heads.
export async function notifyOverdueTask(
  args: {
    orgId: string;
    taskId: string;
    title: string;
    assigneeId?: string | null;
    dueLabel?: string | null;
  },
  client?: Shim
): Promise<number> {
  return notify(
    {
      orgId: args.orgId,
      type: "overdue_task",
      severity: "warning",
      title: `Overdue task · ${args.title}`,
      body: args.dueLabel ? `Was due ${args.dueLabel} and isn't done yet.` : "Past its due date and not done yet.",
      entityType: "task",
      entityId: args.taskId,
      userIds: args.assigneeId ? [args.assigneeId] : undefined,
      roles: args.assigneeId ? undefined : ["ceo", "coo", "department_head"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Overdue case ──────────────────────────────────────────────────────────────
// Fired by the overdue sweep for an open case past its due date. The owner hears
// first, with leadership oversight.
export async function notifyOverdueCase(
  args: {
    orgId: string;
    caseId: string;
    caseNumber?: string | null;
    title: string;
    assignedTo?: string | null;
    dueLabel?: string | null;
  },
  client?: Shim
): Promise<number> {
  const ref = args.caseNumber ? `${args.caseNumber} · ` : "";
  return notify(
    {
      orgId: args.orgId,
      type: "overdue_case",
      severity: "warning",
      title: `Overdue case · ${ref}${args.title}`,
      body: args.dueLabel ? `Was due ${args.dueLabel} and is still open.` : "Past its due date and still open.",
      entityType: "case",
      entityId: args.caseId,
      userIds: args.assignedTo ? [args.assignedTo] : undefined,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Budget threshold ──────────────────────────────────────────────────────────
// Fired when a brand/department budget crosses 80% / 90% / over on its annual or
// monthly line. Leadership-only (CEO + COO) — the people who own the budget. The
// notification points at the budget row so the centre can deep-link to the
// Budgets screen. De-duped per budget so a repeated scan doesn't stack; when
// leadership reads it, a later scan can escalate the band.
export async function notifyBudgetThreshold(
  args: {
    orgId: string;
    budgetId: string;
    scopeLabel: string; // e.g. "Brand · Acme" or "Department · Creative"
    band: BudgetBand;
    dimension: "annual" | "monthly";
    pct: number | null;
    utilized: number;
    budget: number | null;
    remaining: number | null;
  },
  client?: Shim
): Promise<number> {
  const severity = args.band === "exceeded" ? "critical" : args.band === "critical" ? "warning" : "info";
  const pctLabel = args.pct != null ? `${args.pct}%` : "—";
  const remainLabel =
    args.remaining != null
      ? args.remaining >= 0
        ? `${peso(args.remaining)} left`
        : `${peso(Math.abs(args.remaining))} over`
      : "no budget set";
  return notify(
    {
      orgId: args.orgId,
      type: "budget_threshold",
      severity,
      title: `Budget ${BUDGET_BAND_LABEL[args.band].toLowerCase()} · ${args.scopeLabel}`,
      body:
        `${args.dimension === "annual" ? "Annual" : "Monthly"} spend is at ${pctLabel} of budget ` +
        `(${peso(args.utilized)}${args.budget != null ? ` of ${peso(args.budget)}` : ""}) — ${remainLabel}.`,
      entityType: "budget",
      entityId: args.budgetId,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Expense missing supporting document ───────────────────────────────────────
// Fired when an expense is encoded / submitted without a supporting reference
// (reference_number) — the OS has no attachment column, so a blank reference is
// the honest signal that no receipt/invoice is on file. CEO + COO oversight.
export async function notifyExpenseMissingDoc(
  args: {
    orgId: string;
    expenseId: string;
    expenseLabel: string;
    amountLabel?: string | null;
  },
  client?: Shim
): Promise<number> {
  return notify(
    {
      orgId: args.orgId,
      type: "expense_missing_doc",
      severity: "warning",
      title: `Missing document · ${args.expenseLabel}`,
      body:
        `This expense${args.amountLabel ? ` (${args.amountLabel})` : ""} has no supporting reference ` +
        `number on file. Add the receipt / invoice reference before it clears review.`,
      entityType: "expense",
      entityId: args.expenseId,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Duplicate reference number ────────────────────────────────────────────────
// Fired when an expense's reference_number is already used by another expense in
// the org — a classic double-entry / double-payment risk. CEO + COO oversight.
export async function notifyDuplicateReference(
  args: {
    orgId: string;
    expenseId: string;
    expenseLabel: string;
    referenceNumber: string;
    otherCount?: number | null;
  },
  client?: Shim
): Promise<number> {
  const others = args.otherCount && args.otherCount > 0 ? args.otherCount : null;
  return notify(
    {
      orgId: args.orgId,
      type: "duplicate_reference",
      severity: "warning",
      title: `Duplicate reference · ${args.referenceNumber}`,
      body:
        `${args.expenseLabel} reuses reference number “${args.referenceNumber}”` +
        `${others ? `, already on ${others} other expense${others === 1 ? "" : "s"}` : ""}. ` +
        `Check for a double entry before it advances.`,
      entityType: "expense",
      entityId: args.expenseId,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── SLA breach ────────────────────────────────────────────────────────────────
// Fired when a high/urgent case blows its SLA. Same audience as an overdue case
// but critical severity — this is the one that should jump the queue.
export async function notifySlaBreach(
  args: {
    orgId: string;
    caseId: string;
    caseNumber?: string | null;
    title: string;
    assignedTo?: string | null;
    detail?: string | null;
  },
  client?: Shim
): Promise<number> {
  const ref = args.caseNumber ? `${args.caseNumber} · ` : "";
  return notify(
    {
      orgId: args.orgId,
      type: "sla_breach",
      severity: "critical",
      title: `SLA breach · ${ref}${args.title}`,
      body: args.detail ?? "A high-priority case has passed its resolution SLA and is still open.",
      entityType: "case",
      entityId: args.caseId,
      userIds: args.assignedTo ? [args.assignedTo] : undefined,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Probation decision ────────────────────────────────────────────────────────
// Fired when HR / leadership records a probation decision (regularize / extend /
// release) for a new hire. Notifies the hire's SUPERVISOR and the HIRE — the two
// people the outcome directly affects — and points at the person so the bell
// deep-links to the roster. Not de-duped: each decision is a distinct, deliberate
// event the recipients should always see. Best-effort (notify swallows its own
// errors) so a courtesy ping can never fail the transition it accompanies.
const DECISION_VERB: Record<"regularize" | "extend" | "release", string> = {
  regularize: "regularized",
  extend: "extended",
  release: "released",
};

export async function notifyProbationDecision(
  args: {
    orgId: string;
    userId: string;
    personName: string;
    decision: "regularize" | "extend" | "release";
    supervisorId?: string | null;
    newProbationEnd?: string | null;
    note?: string | null;
  },
  client?: Shim
): Promise<number> {
  const recipients = [args.userId, args.supervisorId].filter(
    (id): id is string => !!id
  );
  const verb = DECISION_VERB[args.decision];
  const detail =
    args.decision === "extend" && args.newProbationEnd
      ? ` Probation now ends ${args.newProbationEnd}.`
      : args.decision === "regularize"
        ? " They are now a regular employee."
        : args.decision === "release"
          ? " Their engagement has ended."
          : "";
  return notify(
    {
      orgId: args.orgId,
      type: "probation_decision",
      severity: args.decision === "release" ? "warning" : "info",
      title: `Probation ${verb} · ${args.personName}`,
      body:
        `A probation decision was recorded for ${args.personName}: ${verb}.${detail}` +
        (args.note ? ` Note: ${args.note}` : ""),
      entityType: "user",
      entityId: args.userId,
      userIds: recipients,
    },
    client
  );
}

// ── Probation review due ──────────────────────────────────────────────────────
// Fired by the daily auto-flag scan for a hire whose probation_end is inside the
// 14-day window (upcoming or lapsed). Notifies HR — leadership (ceo/coo) plus the
// HR & Admin department head (passed explicitly, since "HR head" is one person,
// not a role) — and points at the hire so the bell deep-links to the probation
// queue. De-duped per (hire, day) so the daily re-fire never stacks.
export async function notifyProbationReviewDue(
  args: {
    orgId: string;
    userId: string;
    personName: string;
    daysLeft: number | null;
    hrHeadId?: string | null;
  },
  client?: Shim
): Promise<number> {
  const when =
    args.daysLeft == null
      ? "soon"
      : args.daysLeft < 0
        ? `${Math.abs(args.daysLeft)}d ago (lapsed)`
        : args.daysLeft === 0
          ? "today"
          : `in ${args.daysLeft}d`;
  return notify(
    {
      orgId: args.orgId,
      type: "probation_review_due",
      severity: args.daysLeft != null && args.daysLeft < 0 ? "warning" : "info",
      title: `Probation review due · ${args.personName}`,
      body:
        `${args.personName}'s probation ends ${when}. Record a decision ` +
        `(regularize, extend or release) in the probation queue.`,
      entityType: "user",
      entityId: args.userId,
      userIds: args.hrHeadId ? [args.hrHeadId] : undefined,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Sync health alert ─────────────────────────────────────────────────────────
// Fired by the sync-health monitor when the TikTok Shop daily sync is unhealthy:
//   • missing   — the last scheduled run is absent or older than the SLA (>26h)
//   • failed    — the last run classified as failed / auth_failed
//   • token     — a connection's access token expires within 48h (a warning; the
//                 next sync will still bounce to /login once it lapses)
//
// TWO channels, both best-effort: the in-OS bell (CEO + COO) and ONE Telegram
// broadcast to the team group (reusing the same sendTelegram helper + env as the
// "Message Team" button — no new bot, no new env).
//
// IDEMPOTENT — one alert per (incident, day). The incident key is stable for the
// day, so a re-fired daily check writes NOTHING new. Unlike the notify() unread
// de-dupe (which re-sends once leadership reads the bell), we guard on ANY
// notification of this (type, entity) in the last 24h — read or unread — so an
// acknowledged alert is never re-sent the same day across EITHER channel.
export type SyncIncidentKind = "missing" | "failed" | "token";

const SYNC_INCIDENT_SEVERITY: Record<SyncIncidentKind, "info" | "warning" | "critical"> = {
  missing: "critical",
  failed: "critical",
  token: "warning",
};

// Has a sync_health_alert for this exact (org, entity) already gone out today?
// Best-effort — a failed read returns false (better a rare duplicate than a
// swallowed alert).
async function syncAlertAlreadyToday(db: Shim, orgId: string, entityId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  try {
    const { data } = await db
      .from("notifications")
      .select("id")
      .eq("org_id", orgId)
      .eq("type", "sync_health_alert")
      .eq("entity_id", entityId)
      .gte("created_at", since)
      .limit(1);
    return !!(data && (data as unknown[]).length);
  } catch {
    return false;
  }
}

export interface SyncHealthAlertResult {
  sent: boolean; // an alert was written/broadcast this call
  deduped: boolean; // skipped because one already went out today
  bell: number; // notification rows written
  telegram: boolean; // the single group broadcast was accepted
}

export async function notifySyncHealthAlert(
  args: {
    orgId: string;
    kind: SyncIncidentKind;
    // A stable per-incident-per-day key, e.g. `sync:<orgId>:<kind>:<YYYY-MM-DD>`.
    // Both channels and the de-dupe guard key off this.
    incidentId: string;
    title: string;
    body: string;
  },
  client?: Shim
): Promise<SyncHealthAlertResult> {
  const db = client ?? (createServiceRoleClient() as unknown as Shim);
  const result: SyncHealthAlertResult = { sent: false, deduped: false, bell: 0, telegram: false };

  if (await syncAlertAlreadyToday(db, args.orgId, args.incidentId)) {
    result.deduped = true;
    return result;
  }

  const severity = SYNC_INCIDENT_SEVERITY[args.kind];

  // ── Bell (CEO + COO) ──────────────────────────────────────────────────────
  try {
    result.bell = await notify(
      {
        orgId: args.orgId,
        type: "sync_health_alert",
        severity,
        title: args.title,
        body: args.body,
        entityType: "tiktok_sync",
        entityId: args.incidentId,
        roles: ["ceo", "coo"],
        dedupeWithinHours: 24,
      },
      db
    );
  } catch {
    // notify() already swallows its own errors; guard defensively anyway.
  }

  // ── Telegram — ONE group broadcast ────────────────────────────────────────
  try {
    const icon = args.kind === "token" ? "⏳" : "🚨";
    const { ok } = await sendTelegram(
      `${icon} ${escapeHtml(args.title)} — ${escapeHtml(args.body)}`
    );
    result.telegram = ok;
  } catch {
    // sendTelegram never throws, but keep the whole fan-out defensive.
  }

  result.sent = true;
  return result;
}

// ── Weekly Growth Scoreboard ──────────────────────────────────────────────────
// Fired by the Monday cron (/api/automation/scoreboard) after the scoreboard
// engine computes the org's window. Leadership-only — it's Tony's cockpit, so
// the bell goes to the people who steer. The digest text is pre-formatted by
// lib/automation/scoreboard-digest.ts from the SAME live numbers /scoreboard
// renders; nothing is re-derived or invented here.
//
// De-duped on a stable per-(org, week, window) entity id so a manual re-run of
// the route the same day never stacks duplicate bells (unread de-dupe only —
// if leadership read and cleared it, a deliberate re-run may legitimately
// re-notify).
export async function notifyWeeklyScoreboard(
  args: {
    orgId: string;
    // Stable dedupe key for this run, e.g. `weekly:<orgId>:<YYYY-MM-DD>`.
    digestId: string;
    title: string;
    body: string;
  },
  client?: Shim
): Promise<number> {
  return notify(
    {
      orgId: args.orgId,
      type: "weekly_scoreboard",
      severity: "info",
      title: args.title,
      body: args.body,
      entityType: "scoreboard",
      entityId: args.digestId,
      roles: ["ceo", "coo"],
      dedupeWithinHours: 96,
    },
    client
  );
}

// ── Approval escalation ───────────────────────────────────────────────────────
// Fired by the daily sweep (/api/automation/approval-sweep) for an action_request
// that has sat pending past APPROVAL_ESCALATION_HOURS without a decision. Same
// audience as notifyPendingApproval (exactly the roles RLS lets decide it), but
// warning severity — this is the nudge, not the first hello. Points at the same
// request row so the centre still offers the gated decision.
export async function notifyApprovalEscalation(
  args: {
    orgId: string;
    actionRequestId: string;
    title: string;
    requiredRole?: string | null;
    ageHours: number;
  },
  client?: Shim
): Promise<number> {
  return notify(
    {
      orgId: args.orgId,
      type: "approval_escalation",
      severity: "warning",
      title: `Still waiting · ${args.title}`,
      body:
        `This request has been pending ~${args.ageHours}h without a decision. ` +
        `Approve, reject or cancel it in the Approval Queue.`,
      entityType: "action_request",
      entityId: args.actionRequestId,
      roles: approverRoles(args.requiredRole),
      dedupeWithinHours: 20,
    },
    client
  );
}

// ── Approval outcome report-back ──────────────────────────────────────────────
// Fired by the daily sweep for a request the USER FILED that reached a terminal
// decision in the last 24h — approved, executed, rejected, failed, expired or
// cancelled. This is the loop-closer: the requester hears the outcome without
// having to poll the queue. Self-decided requests are excluded upstream
// (outcomeCandidates). A failed execution is CRITICAL — the filer drafted this
// action in good faith and it broke; silence there is never acceptable.
export async function notifyRequesterOutcome(
  args: {
    orgId: string;
    actionRequestId: string;
    requesterId: string;
    requestTitle: string;
    kind: OutcomeKind;
    note?: string | null;
  },
  client?: Shim
): Promise<number> {
  const label = OUTCOME_LABEL[args.kind];
  return notify(
    {
      orgId: args.orgId,
      type: "approval_outcome",
      severity: outcomeSeverity(args.kind),
      title: `Your request was ${label} · ${args.requestTitle}`,
      body:
        `“${args.requestTitle}” was ${label}.` +
        (args.note ? ` Note: ${args.note}` : "") +
        ` Details in the Approval Queue.`,
      entityType: "action_request",
      entityId: args.actionRequestId,
      userIds: [args.requesterId],
      dedupeWithinHours: 20,
    },
    client
  );
}
