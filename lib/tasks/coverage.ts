// lib/tasks/coverage.ts — Head Cover Mode.
//
// When a member is out, a department head (or leadership) can act on that
// member's task on their behalf — reassign it, change its status, or mark it
// complete. This module holds the ONE authorization predicate the feature turns
// on, plus the best-effort notice to the task's original owner.
//
// GOVERNING RULES (mirror the rest of the OS):
//   • Coverage is acting on SOMEONE ELSE's task. Acting on your own task is a
//     normal edit, never "coverage" — canCoverTask returns false for self.
//   • A department head may cover ONLY within their own department — never
//     another department's tasks. Leadership (ceo/coo) may cover any task in the
//     org. Members never cover.
//   • The predicate is the single source of truth the UI (which controls to
//     show) and the /api/tasks/cover route (which enforces the write) both read,
//     so the surface a head sees and what the server will accept never disagree.
//   • Notifying the owner is best-effort — a failed notice never blocks (or
//     un-does) the coverage action that already committed.

import type { UserRole } from "@/types/database";
import { notify } from "@/lib/notifications/notify";
import { sendEmail, isEmailConfigured, isEmailNotConfigured } from "@/lib/outreach/email";

// Leadership covers the whole org; a department head covers only their own
// department. Kept here so the gate and any caller agree on who "leadership" is.
export const COVERAGE_LEADERSHIP: ReadonlySet<UserRole> = new Set<UserRole>(["ceo", "coo"]);

// The three things coverage can do to a member's task. 'complete' is a
// convenience shorthand for setting status to 'done'.
export type CoverAction = "reassign" | "status" | "complete";

export interface Coverer {
  id: string;
  role: UserRole;
  department_id: string | null;
}

export interface TaskOwner {
  id: string | null;
  department_id: string | null;
}

// The ONE coverage gate. True only when `coverer` may act on `owner`'s task on
// the owner's behalf:
//   • never your own task (that's a normal edit, not coverage),
//   • never a task with no owner to cover,
//   • leadership → any owner in the org,
//   • department_head → only an owner in the SAME department (and only when the
//     head actually has a department set — a head with no department covers no
//     one, never "matches" a member whose department is also null),
//   • everyone else → never.
export function canCoverTask(coverer: Coverer, owner: TaskOwner): boolean {
  if (!owner.id || owner.id === coverer.id) return false;
  if (COVERAGE_LEADERSHIP.has(coverer.role)) return true;
  if (coverer.role === "department_head") {
    return !!coverer.department_id && coverer.department_id === owner.department_id;
  }
  return false;
}

export interface NotifyOwnerCoveredInput {
  orgId: string;
  taskId: string;
  taskTitle: string;
  ownerId: string;
  ownerEmail: string | null;
  covererName: string;
  action: CoverAction;
  // A short human phrase describing what was done, e.g. "reassigned it to Jane",
  // 'set the status to "In progress"', or "marked it complete". Composed by the
  // route so the notice reads the same in the bell and the email.
  summary: string;
}

export interface NotifyOwnerCoveredResult {
  bell: number; // notification rows written (0 or 1)
  emailed: boolean; // the owner's email was accepted by the sender
}

// Tell the task's ORIGINAL OWNER their task was covered — an in-OS bell plus a
// best-effort email. Both channels are independent and never throw: the coverage
// action has already committed by the time this runs, so a failed notice must
// leave it intact.
export async function notifyOwnerCovered(
  input: NotifyOwnerCoveredInput
): Promise<NotifyOwnerCoveredResult> {
  const result: NotifyOwnerCoveredResult = { bell: 0, emailed: false };

  // ── IN-OS bell ──────────────────────────────────────────────────────────────
  try {
    result.bell = await notify({
      orgId: input.orgId,
      type: "task_covered",
      title: "Your task was covered",
      body: `${input.covererName} ${input.summary} on your task "${input.taskTitle}".`,
      severity: "info",
      entityType: "task",
      entityId: input.taskId,
      userIds: [input.ownerId],
    });
  } catch {
    // notify() already swallows its own errors; guard defensively anyway.
  }

  // ── EMAIL (best-effort) ─────────────────────────────────────────────────────
  if (isEmailConfigured() && input.ownerEmail && input.ownerEmail.trim()) {
    try {
      await sendEmail({
        to: input.ownerEmail.trim(),
        subject: `Your task was covered: ${input.taskTitle}`,
        text:
          `${input.covererName} ${input.summary} on your task while you were out.\n\n` +
          `Task: ${input.taskTitle}\n\n` +
          `Open Mthryve OS → Tasks to review.`,
      });
      result.emailed = true;
    } catch (e) {
      // A not-configured mailer is not an error — the bell still landed.
      if (!isEmailNotConfigured(e)) {
        console.error("[cover] email send failed", e instanceof Error ? e.message : e);
      }
    }
  }

  return result;
}
