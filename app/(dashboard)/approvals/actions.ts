"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeAudit } from "@/lib/audit/log";
import { executeApprovedAction } from "@/lib/actions/executor";
import { canDecide, type ActionRequestRow, type RequiredRole } from "@/lib/actions/types";

// Server actions behind the Action & Approval Queue. The human gate lives here:
// APPROVE / REJECT flip a pending request, and ONLY on approve does the OS run
// the executor. RLS on action_requests is the real authority — the UPDATE is
// scoped to status='pending' so two approvers can't both win, and the policy
// itself rejects a role that may not decide the row, so we never re-implement
// the tier gating in app code. We only add a friendly pre-check for a clean
// message.
//
// action_requests / action_audit aren't in the generated Database types yet, so
// they're reached through the same cast shim the Live and Contracts modules use.
type Shim = { from: (t: string) => any };

export interface DecisionResult {
  ok: boolean;
  status?: string;
  error?: string;
}

function shim() {
  return createServerSupabaseClient() as unknown as Shim;
}

// Approve a request, then execute its proposed action. Reject just records the
// decision. `note` is the optional decision_note. `draftedMessage` is the
// (optionally edited) follow-up text for a 'log_followup' request — the approver
// can revise Tony's draft on the card before approving, and the final text is
// what gets logged.
export async function decideActionRequest(
  requestId: string,
  decision: "approved" | "rejected",
  note?: string | null,
  draftedMessage?: string | null
): Promise<DecisionResult> {
  if (!requestId) return { ok: false, error: "Missing request." };
  const profile = await requireProfile();
  const db = shim();

  // Read the row (RLS-scoped to the caller's org) to pre-check permission and
  // that it's still pending — a clean message beats a silent RLS no-op.
  const { data: current } = await db
    .from("action_requests")
    .select("id, status, required_role")
    .eq("id", requestId)
    .maybeSingle();
  const row = current as { id: string; status: string; required_role: RequiredRole } | null;
  if (!row) return { ok: false, error: "Request not found." };
  if (row.status !== "pending") return { ok: false, error: "This request was already decided." };
  if (!canDecide(profile.role, row.required_role)) {
    return { ok: false, error: "You don't have permission to decide this request." };
  }

  const decidedAt = new Date().toISOString();
  const cleanNote = (note ?? "").trim() || null;

  // A rejection must record why — the reason lands on the audit row the DB
  // decision-audit trigger writes.
  if (decision === "rejected" && !cleanNote) {
    return { ok: false, error: "A rejection needs a brief reason." };
  }

  // Atomic flip: only a still-pending row is updated, and RLS re-checks the
  // caller's role. .select('*') returns the row we just wrote (empty if the
  // guard/RLS blocked it) — and gives the executor everything it needs.
  const { data: updated, error: updErr } = await db
    .from("action_requests")
    .update({
      status: decision,
      decided_by: profile.id,
      decided_at: decidedAt,
      decision_note: cleanNote,
      updated_at: decidedAt,
    })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (updErr) return { ok: false, error: updErr.message };
  const request = updated as ActionRequestRow | null;
  if (!request) return { ok: false, error: "This request was already decided." };

  // The action_audit decision row is written at the DB by the
  // tg_action_decision_audit trigger on the pending→approved/rejected
  // transition — the trail is guaranteed no matter which path (or raw SQL)
  // decided the row, so the app no longer writes it here.

  // Privileged-action trail — the human approve/reject on an action_request.
  await writeAudit({
    action: "approval_decision",
    entityType: "action_request",
    entityId: request.id,
    actorUserId: profile.id,
    actorRole: profile.role,
    orgId: request.org_id,
    detail: {
      decision,
      ...(request.source_module ? { source_module: request.source_module } : {}),
      ...(cleanNote ? { note: cleanNote } : {}),
    },
  });

  let finalStatus: string = decision;

  // Rejecting an expense gate KICKS THE EXPENSE BACK to 'encoded' for correction
  // and re-submission (the DB status vocabulary has no separate hold state). The
  // expenses table is ceo/coo-writable only, but a department_head may reject a
  // department_approval request — so this write is done by the SERVICE ROLE (the
  // same reason the executor advances the expense with elevated rights on
  // approval). Best-effort: the recorded rejection stands regardless.
  if (decision === "rejected" && request.source_module === "expense") {
    const expenseId = (request.source_ref as { expense_id?: string } | null)?.expense_id ?? null;
    if (expenseId) {
      try {
        const svc = createServiceRoleClient() as unknown as Shim;
        await svc
          .from("expenses")
          .update({ workflow_stage: "encoded", status: "pending", updated_at: new Date().toISOString() })
          .eq("id", expenseId);
        revalidatePath("/finance/expenses");
      } catch {
        // Kicking the expense back is a courtesy on top of the recorded rejection.
      }
    }
  }

  // Only approval triggers execution, and only when the request actually carries
  // an executable action. Recommendation-only requests (proposed_action null —
  // e.g. Tony's finance/general recommendations, where money is NEVER executed)
  // have nothing to run: approval simply acknowledges them, so they rest at
  // 'approved'. The executor is service-role, records its own 'executed'/'failed'
  // audit + result, and never throws.
  if (decision === "approved" && request.proposed_action?.type) {
    // For an editable follow-up, persist the approver's final text into the
    // request before executing, so the logged message and the stored draft agree
    // and the trail reflects exactly what was sent-to-log. A blank edit falls
    // back to Tony's original draft (never blanks the message).
    if (
      request.proposed_action?.type === "log_followup" ||
      request.proposed_action?.type === "send_outreach"
    ) {
      const edited = (draftedMessage ?? "").trim();
      const original = String(
        (request.proposed_action.payload?.drafted_message as string | undefined) ?? ""
      ).trim();
      const finalMessage = edited || original;
      if (finalMessage !== original) {
        const mergedAction = {
          ...request.proposed_action,
          payload: { ...request.proposed_action.payload, drafted_message: finalMessage },
        };
        await db
          .from("action_requests")
          .update({ proposed_action: mergedAction, updated_at: new Date().toISOString() })
          .eq("id", request.id);
        request.proposed_action = mergedAction;
      }
    }

    const exec = await executeApprovedAction(request);
    finalStatus = exec.ok ? "executed" : "failed";
  }

  revalidatePath("/approvals");
  revalidatePath("/contracts");
  revalidatePath("/projects");
  revalidatePath("/outreach");
  revalidatePath("/creators");
  revalidatePath("/tasks");
  revalidatePath("/warehouse/intelligence");
  revalidatePath("/ad-ops");
  return { ok: true, status: finalStatus };
}
