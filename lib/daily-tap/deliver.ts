// lib/daily-tap/deliver.ts — delivers one built tap and records it, idempotently.
//
// Per user, per day:
//   1. IDEMPOTENCY — skip entirely if a daily_taps row already exists for
//      (user_id, tap_date). The unique constraint is the backstop; the pre-check
//      keeps a re-run from re-sending a notification/email.
//   2. IN-APP — write a notifications row (type='daily_tap') pointing at the tap.
//   3. EMAIL — send via the shared Resend sender ONLY when a transport is
//      configured and the user has an address. A not-configured mailer is not an
//      error — the tap still lands in-app.
//   4. RECORD — insert the daily_taps row with the channels that actually
//      reached the user, ai_used, the summary, and last_nudge_at = now (the tap
//      creation is the first nudge; the in-app snooze cadence counts from here).
//
// Everything runs on the SERVICE-ROLE client (the automation caller has no user
// session). Best-effort on the courtesy channels; the daily_taps record is the
// source of truth the inbox reads.

import { sendEmail, isEmailConfigured, isEmailNotConfigured } from "@/lib/outreach/email";
import type { BuiltTap, TapChannel, TapUser } from "@/lib/daily-tap/types";

type Shim = { from: (t: string) => any };

export type DeliverOutcome = "created" | "skipped" | "failed";

export interface DeliverResult {
  userId: string;
  outcome: DeliverOutcome;
  channels: TapChannel[];
  tier: BuiltTap["tier"] | null;
  aiUsed: boolean;
  error?: string;
}

// Has this user already been tapped today? (idempotency pre-check)
async function alreadyTapped(db: Shim, userId: string, today: string): Promise<boolean> {
  try {
    const { data } = await db
      .from("daily_taps")
      .select("id")
      .eq("user_id", userId)
      .eq("tap_date", today)
      .maybeSingle();
    return !!(data as { id?: string } | null)?.id;
  } catch {
    return false;
  }
}

// Write the in-app notification row (type='daily_tap'). Best-effort.
async function writeNotification(db: Shim, user: TapUser, tap: BuiltTap): Promise<boolean> {
  try {
    const { error } = await db.from("notifications").insert({
      org_id: user.org_id,
      user_id: user.id,
      type: "daily_tap",
      title: tap.title,
      body: tap.summary,
      severity: "info",
      entity_type: "daily_tap",
    });
    return !error;
  } catch {
    return false;
  }
}

// Send the email via the shared Resend/SMTP sender. Returns false (not throws)
// when the mailer isn't configured or the send fails — the tap still lands in-app.
async function sendTapEmail(user: TapUser, tap: BuiltTap): Promise<boolean> {
  if (!user.email || !isEmailConfigured()) return false;
  try {
    await sendEmail({ to: user.email, subject: tap.title, text: tap.summary });
    return true;
  } catch (e) {
    if (isEmailNotConfigured(e)) return false;
    console.error("[daily-tap] email send failed", e instanceof Error ? e.message : e);
    return false;
  }
}

// Deliver + record one tap. Idempotent per (user, tap_date).
export async function deliverTap(
  db: Shim,
  user: TapUser,
  tap: BuiltTap,
  today: string
): Promise<DeliverResult> {
  if (await alreadyTapped(db, user.id, today)) {
    return { userId: user.id, outcome: "skipped", channels: [], tier: tap.tier, aiUsed: tap.aiUsed };
  }

  const channels: TapChannel[] = [];
  if (await writeNotification(db, user, tap)) channels.push("inapp");
  if (await sendTapEmail(user, tap)) channels.push("email");

  // Record the tap. status='sent' when at least one channel reached the user,
  // else 'failed' (recorded honestly so the day isn't silently skipped). The
  // unique constraint makes a concurrent double-run insert fail — treat that as
  // an idempotent skip, not an error.
  const status = channels.length > 0 ? "sent" : "failed";
  try {
    const { error } = await db.from("daily_taps").insert({
      org_id: user.org_id,
      user_id: user.id,
      tap_date: today,
      tier: tap.tier,
      channels,
      ai_used: tap.aiUsed,
      summary: tap.summary,
      status,
      last_nudge_at: new Date().toISOString(),
    });
    if (error) {
      // 23505 = unique_violation → another run already recorded today's tap.
      if ((error as { code?: string }).code === "23505") {
        return { userId: user.id, outcome: "skipped", channels: [], tier: tap.tier, aiUsed: tap.aiUsed };
      }
      return {
        userId: user.id,
        outcome: "failed",
        channels,
        tier: tap.tier,
        aiUsed: tap.aiUsed,
        error: (error as { message?: string }).message ?? "insert failed",
      };
    }
  } catch (e) {
    return {
      userId: user.id,
      outcome: "failed",
      channels,
      tier: tap.tier,
      aiUsed: tap.aiUsed,
      error: e instanceof Error ? e.message : "insert threw",
    };
  }

  return {
    userId: user.id,
    outcome: status === "sent" ? "created" : "failed",
    channels,
    tier: tap.tier,
    aiUsed: tap.aiUsed,
  };
}
