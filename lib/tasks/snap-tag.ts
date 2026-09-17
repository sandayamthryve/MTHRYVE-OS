// lib/tasks/snap-tag.ts — the three-channel fan-out for Snap-Tag.
//
// When leadership / a department head tags teammates onto a task (see the
// /api/tasks/snap-tag route), each NEWLY tagged person is told across three
// independent, best-effort channels. The channels never gate one another and
// never gate the tag write that precedes them — any one failing leaves the
// others (and the task_tags rows) intact:
//
//   a. IN-OS bell   — one notifications row per newly tagged user (type
//                     'task_tag'), de-duped against a still-unread tag for the
//                     same task within the last day. Runs on the service-role
//                     client inside notify().
//   b. EMAIL        — one message to each tagged user's users.email via the
//                     shared Resend/SMTP sender. A not-configured mailer is not
//                     an error — the bell + Telegram still land.
//   c. TELEGRAM     — ONE broadcast to the team group, reusing the SAME
//                     sendTelegram helper (and its TELEGRAM_BOT_TOKEN /
//                     TELEGRAM_CHAT_ID env) that backs the "Message Team" button.
//                     No new bot, no new env.
//
// The task CREATOR is never notified — even if they tagged themselves — so a
// self-tag pings no one. Server-only by construction (Telegram + email creds).

import { notify } from "@/lib/notifications/notify";
import { sendEmail, isEmailConfigured, isEmailNotConfigured } from "@/lib/outreach/email";
import { sendTelegram, escapeHtml } from "@/lib/telegram";

// A person eligible to be tagged, resolved from public.users in the org.
export interface TaggedUser {
  id: string;
  full_name: string;
  email: string | null;
  telegram_username: string | null;
}

export interface NotifyTaggedInput {
  orgId: string;
  taskId: string;
  taskTitle: string;
  dueDate: string | null; // task due_date (YYYY-MM-DD) or null
  creatorId: string | null; // task.created_by — never notified
  creatorName: string; // shown in the broadcast as "by <Creator>"
  // The users tagged in THIS action (already de-duped against existing tags).
  newlyTagged: TaggedUser[];
}

export interface NotifyTaggedResult {
  recipients: number; // newly tagged, minus the creator
  bell: number; // notification rows written
  emailed: number; // emails accepted by the sender
  telegram: boolean; // the single group broadcast was accepted
}

// Normalise a stored Telegram handle to a bare username (no leading @), or null.
function bareHandle(raw: string | null): string | null {
  const h = (raw ?? "").replace(/^@+/, "").trim();
  return h || null;
}

// An honest due-date phrase for the broadcast — never a fabricated date.
function dueText(dueDate: string | null): string {
  return dueDate ? dueDate : "no due date";
}

// Fire all three channels for a snap-tag. Best-effort throughout: every channel
// is wrapped so one failing (or being unconfigured) never throws or blocks the
// others. Returns a small summary for the route to log.
export async function notifyTagged(input: NotifyTaggedInput): Promise<NotifyTaggedResult> {
  // Recipients = newly tagged, minus the creator, de-duped by id.
  const seen = new Set<string>();
  const recipients = input.newlyTagged.filter((u) => {
    if (!u.id || u.id === input.creatorId || seen.has(u.id)) return false;
    seen.add(u.id);
    return true;
  });

  const result: NotifyTaggedResult = {
    recipients: recipients.length,
    bell: 0,
    emailed: 0,
    telegram: false,
  };
  if (recipients.length === 0) return result;

  const due = dueText(input.dueDate);

  // ── a. IN-OS bell ─────────────────────────────────────────────────────────
  try {
    result.bell = await notify({
      orgId: input.orgId,
      type: "task_tag",
      title: `You were tagged on a task`,
      body: `${input.creatorName} tagged you on "${input.taskTitle}" (due ${due}).`,
      severity: "info",
      entityType: "task",
      entityId: input.taskId,
      userIds: recipients.map((u) => u.id),
      // Once/day de-dupe against a still-unread tag for the same task.
      dedupeWithinHours: 20,
    });
  } catch {
    // notify() already swallows its own errors; guard defensively anyway.
  }

  // ── b. EMAIL (Resend / SMTP) ──────────────────────────────────────────────
  if (isEmailConfigured()) {
    const subject = `New task: ${input.taskTitle}`;
    const outcomes = await Promise.allSettled(
      recipients
        .filter((u) => u.email && u.email.trim())
        .map((u) =>
          sendEmail({
            to: u.email!.trim(),
            subject,
            text:
              `${input.creatorName} tagged you on a task.\n\n` +
              `Task: ${input.taskTitle}\n` +
              `Due: ${due}\n\n` +
              `Open Mthryve OS → Tasks to see the full detail.`,
          })
        )
    );
    result.emailed = outcomes.filter((o) => o.status === "fulfilled").length;
    for (const o of outcomes) {
      if (o.status === "rejected" && !isEmailNotConfigured(o.reason)) {
        console.error(
          "[snap-tag] email send failed",
          o.reason instanceof Error ? o.reason.message : o.reason
        );
      }
    }
  }

  // ── c. TELEGRAM — ONE group broadcast ─────────────────────────────────────
  // @<handle> when set (pings in the group), else the plain escaped name.
  try {
    const mentions = recipients
      .map((u) => {
        const handle = bareHandle(u.telegram_username);
        return handle ? `@${escapeHtml(handle)}` : escapeHtml(u.full_name);
      })
      .join(", ");
    const text =
      `📋 New task: ${escapeHtml(input.taskTitle)} — ${mentions} ` +
      `(by ${escapeHtml(input.creatorName)}, due ${escapeHtml(due)})`;
    const { ok } = await sendTelegram(text);
    result.telegram = ok;
  } catch {
    // sendTelegram never throws, but keep the whole fan-out defensive.
  }

  return result;
}
