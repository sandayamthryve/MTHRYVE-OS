"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { checkPolicy } from "@/lib/governance/policy";
import { decideActionRequest } from "@/app/(dashboard)/approvals/actions";

// Server actions behind the Notification Centre.
//
//   • mark-read — the ONLY mutation a recipient makes to their own row. RLS on
//     notifications allows UPDATE only where user_id = auth.uid(), so this runs
//     on the caller's RLS client: a user can flip only their own notifications,
//     and leadership (who can READ everyone's) still can't mark someone else's.
//
//   • approve-from-notification — the in-notification action. It does NOT
//     auto-execute anything: it consults the policy_registry (checkPolicy) and
//     then routes the decision through the SAME approval spine the Approval
//     Queue uses (decideActionRequest), which re-checks RLS + required_role and
//     only runs the executor on approve. The notification is just a shortcut to
//     that gated flow, then marks itself read.
//
// notifications isn't in the generated Database types yet, so it's reached
// through the app's cast shim.
type Shim = { from: (t: string) => any };

function shim() {
  return createServerSupabaseClient() as unknown as Shim;
}

export interface NotifyActionResult {
  ok: boolean;
  error?: string;
}

// Mark one of the caller's notifications read (idempotent; RLS-scoped to owner).
export async function markNotificationRead(id: string): Promise<NotifyActionResult> {
  if (!id) return { ok: false, error: "Missing notification." };
  await requireProfile();
  const db = shim();
  try {
    await db.from("notifications").update({ read: true }).eq("id", id).eq("read", false);
  } catch {
    // Best-effort — a failed mark-read is not worth surfacing.
  }
  revalidatePath("/notifications");
  return { ok: true };
}

// Mark every unread notification the caller owns read. RLS limits the UPDATE to
// their own rows, so the org filter is only belt-and-braces.
export async function markAllNotificationsRead(): Promise<NotifyActionResult> {
  const profile = await requireProfile();
  const db = shim();
  try {
    await db
      .from("notifications")
      .update({ read: true })
      .eq("user_id", profile.id)
      .eq("read", false);
  } catch {
    // Best-effort.
  }
  revalidatePath("/notifications");
  return { ok: true };
}

// Approve a pending action_request straight from its notification. Consults the
// policy_registry, then hands the decision to the approval spine — the spine is
// the single place the RLS/role gate + executor live, so nothing is duplicated
// and nothing auto-executes outside that gate.
export async function approveFromNotification(
  notificationId: string,
  actionRequestId: string,
  note?: string | null
): Promise<NotifyActionResult> {
  if (!actionRequestId) return { ok: false, error: "Missing request." };
  const profile = await requireProfile();

  // Route through the centralized rulebook first. A human is approving a
  // consequential action, so the rule resolves to allow-with-approval; the
  // consult is recorded to action_audit by checkPolicy. A registry read error
  // fails open (the spine below still enforces RLS + role), so this never
  // becomes a brittle second gate.
  const policy = await checkPolicy("ai_execute", {
    orgId: profile.org_id,
    actorId: profile.id,
    actorRole: profile.role,
    approved: true,
    actionRequestId,
    detail: { via: "notification_centre", notification_id: notificationId },
  });
  if (policy.decision === "deny") {
    return { ok: false, error: policy.reason };
  }

  // The spine does the real work: it re-checks RLS + required_role, flips the
  // pending row atomically, audits the human decision, and runs the executor
  // ONLY on approve for requests that carry an executable action.
  const result = await decideActionRequest(actionRequestId, "approved", note ?? null);
  if (!result.ok) return { ok: false, error: result.error };

  // Approved through the gate → mark the prompting notification read.
  if (notificationId) await markNotificationRead(notificationId);
  revalidatePath("/notifications");
  revalidatePath("/approvals");
  return { ok: true };
}
