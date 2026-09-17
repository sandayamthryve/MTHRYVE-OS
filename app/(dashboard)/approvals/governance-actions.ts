"use server";

// app/(dashboard)/approvals/governance-actions.ts — the server actions behind the
// governed permanent-delete gate (COO → CEO, strictly sequential).
//
// Two entry points:
//   • requestGovernedDeletion — ANY signed-in member may file a delete request
//     (the task board's "Request deletion" button). Files ONE action_requests row
//     (source_module='governance', status='pending_coo', approval_chain='coo,ceo')
//     and notifies the COO. Nothing is deleted here.
//   • decideGovernedDeletion — the current-stage officer approves/rejects in the
//     Approvals inbox. It walks the chain and, ONLY on the CEO's final approval,
//     runs the executor to hard-delete.
//
// SERVER-SIDE ENFORCEMENT (non-negotiable, all checked here before any write):
//   • Stage 1 (status='pending_coo') requires role='coo'. Stage 2
//     (status='pending_ceo') requires role='ceo'. No skipping stage 1 (a CEO
//     cannot act on a pending_coo row); no single person can complete both stages
//     (the two stages demand two distinct roles).
//   • Every state transition is a guarded update (…eq('status', <expected>)) so a
//     stale card or a double-click can never re-decide or double-execute a row.
//   • Nothing is ever deleted except through the executor on approved→executed.
//
// Reads/writes on action_requests + the entity tables run through the SERVICE
// ROLE: RLS only lets leadership INSERT action_requests (so a team_member's
// request would be blocked), and a permanent delete must work regardless of a
// table's RLS DELETE policy. The role gate above IS the authority; org_id is
// always stamped from the verified session, never from client input.

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import { writeAudit } from "@/lib/audit/log";
import { notify } from "@/lib/notifications/notify";
import { sendTelegram, escapeHtml } from "@/lib/telegram";
import { executeGovernedDelete } from "@/lib/governance/delete-executor";
import {
  GOVERNANCE_SOURCE_MODULE,
  GOVERNED_DELETE_CHAIN_STR,
  governedDeleteEntity,
  parseHardDelete,
  type GovActionState,
} from "@/lib/governance/delete-entities";
import type { ActionRequestRow } from "@/lib/actions/types";

type Shim = { from: (t: string) => any };

let nonceCounter = 0;
function ok(message: string): GovActionState {
  return { ok: true, message, nonce: ++nonceCounter };
}
function fail(error: string): GovActionState {
  return { ok: false, error, nonce: ++nonceCounter };
}

function svcShim(): Shim {
  return createServiceRoleClient() as unknown as Shim;
}

// ── Request a governed deletion ───────────────────────────────────────────────
// Called by the task board's "Request deletion" control (useFormState). Visible
// to every role: any signed-in member may ASK; the two-officer chain is what
// actually gates the delete.
export async function requestGovernedDeletion(
  _prev: GovActionState | null,
  formData: FormData
): Promise<GovActionState> {
  const entityKey = String(formData.get("entity") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail("Unknown record.");

  const entity = governedDeleteEntity(entityKey);
  if (!entity) return fail("This record can't be deletion-requested here.");

  const profile = await requireProfile();
  const svc = svcShim();

  // Read the target within the caller's org (archived-aware: an archived row can
  // still be requested for permanent deletion). We need its title for the card.
  // De-dupe the column list: some entities use "id" itself as their titleField
  // (e.g. affiliate rows with no human title), which would otherwise select "id"
  // twice and error in PostgREST.
  const selectCols = [...new Set(["id", entity.titleField, "archived_at"])].join(", ");
  const { data: row } = await createServerSupabaseClient()
    .from(entity.table)
    .select(selectCols)
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .maybeSingle();
  const target = row as Record<string, unknown> | null;
  if (!target) return fail("That record no longer exists.");
  const rowTitle = String(target[entity.titleField] ?? "").trim() || `(untitled ${entity.label})`;

  // Best-effort de-dupe: don't stack a second live request on the same row.
  try {
    const { data: existing } = await svc
      .from("action_requests")
      .select("id, status")
      .eq("org_id", profile.org_id)
      .eq("source_module", GOVERNANCE_SOURCE_MODULE)
      .eq("source_ref->>entity", entityKey)
      .eq("source_ref->>id", id)
      .in("status", ["pending_coo", "pending_ceo"]);
    if (((existing as unknown[] | null) ?? []).length > 0) {
      return fail("A deletion request for this record is already in the approval queue.");
    }
  } catch {
    // A failed de-dupe read must never block a legitimate request.
  }

  const title = `Delete ${entity.label}: ${rowTitle}`;
  const { data: inserted, error } = await svc
    .from("action_requests")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      source_module: GOVERNANCE_SOURCE_MODULE,
      source_ref: { entity: entityKey, id },
      title,
      problem: `A permanent delete was requested for this ${entity.label}. It requires COO approval, then CEO approval — nothing is deleted until both sign off.`,
      recommendation: `Approve only if this ${entity.label} should be permanently removed. This cannot be undone once executed.`,
      confidence: null,
      risk_tier: 4,
      required_role: "coo",
      proposed_action: { type: "hard_delete", entity: entityKey, id },
      approval_chain: GOVERNED_DELETE_CHAIN_STR,
      status: "pending_coo",
    })
    .select("id")
    .single();

  const requestId = (inserted as { id?: string } | null)?.id ?? null;
  if (error || !requestId) {
    return fail(error?.message || "Could not file the deletion request.");
  }

  // Trail: who asked (the real user), as the 'created' event.
  await writeActionAudit(svc, {
    org_id: profile.org_id,
    action_request_id: requestId,
    event: "created",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: { source: "governance_delete", entity: entityKey, id, chain: GOVERNED_DELETE_CHAIN_STR },
  });

  // Privileged-action trail: a permanent-delete was requested (start of the
  // COO→CEO lifecycle). entity_id is the request; the target row is in detail.
  await writeAudit({
    action: "delete_requested",
    entityType: "action_request",
    entityId: requestId,
    actorUserId: profile.id,
    actorRole: profile.role,
    orgId: profile.org_id,
    detail: { entity: entityKey, target_id: id, title: rowTitle },
  });

  // Stage 1 approver: the COO hears first — bell + one Telegram group broadcast
  // (both best-effort; a notification never gates the request it accompanies).
  await notify({
    orgId: profile.org_id,
    type: "governed_delete",
    severity: "warning",
    title: `Delete approval needed · ${title}`,
    body: `${profile.full_name} requested a permanent delete. As COO you approve first, then the CEO gives final sign-off.`,
    entityType: "action_request",
    entityId: requestId,
    roles: ["coo"],
  });
  await sendTelegram(
    `🗑️ <b>Permanent delete requested</b>\n${escapeHtml(profile.full_name)} asked to delete: ${escapeHtml(rowTitle)}.\nNeeds COO approval, then CEO final sign-off — review in Approvals.`
  );

  revalidatePath("/approvals");
  for (const p of entity.revalidate) revalidatePath(p);
  return ok("Deletion requested — awaiting COO approval.");
}

// ── Decide a governed deletion ────────────────────────────────────────────────
// Called by the Approvals inbox card. Enforces the stage→role gate, walks the
// chain, and runs the executor ONLY on the CEO's final approval.
export async function decideGovernedDeletion(
  requestId: string,
  decision: "approved" | "rejected",
  note?: string | null
): Promise<GovActionState> {
  if (!requestId) return fail("Missing request.");
  const profile = await requireProfile();
  const svc = svcShim();
  const now = new Date().toISOString();
  const cleanNote = (note ?? "").trim() || null;

  // Read the row within the caller's org.
  const { data: current } = await svc
    .from("action_requests")
    .select("*")
    .eq("id", requestId)
    .eq("org_id", profile.org_id)
    .maybeSingle();
  const row = current as ActionRequestRow | null;
  if (!row) return fail("Request not found.");
  if (row.source_module !== GOVERNANCE_SOURCE_MODULE) {
    return fail("This isn't a governed deletion request.");
  }

  // The entity being deleted (for post-execution revalidation). Parsed from the
  // proposed_action so an unknown/malformed action simply yields no extra paths.
  const entity = governedDeleteEntity(parseHardDelete(row.proposed_action)?.entity);

  // ── Stage 1 — COO ───────────────────────────────────────────────────────────
  if (row.status === "pending_coo") {
    if (profile.role !== "coo") {
      return fail("Stage 1 requires the COO — only the COO can make the first decision.");
    }

    if (decision === "rejected") {
      const { data: updated } = await svc
        .from("action_requests")
        .update({
          status: "rejected",
          first_decision: "rejected",
          first_decided_by: profile.id,
          first_decided_at: now,
          first_note: cleanNote,
          decided_by: profile.id,
          decided_at: now,
          updated_at: now,
        })
        .eq("id", requestId)
        .eq("status", "pending_coo")
        .select("id")
        .maybeSingle();
      if (!updated) return fail("This request was already decided.");

      await writeActionAudit(svc, {
        org_id: row.org_id,
        action_request_id: requestId,
        event: "rejected",
        actor_id: profile.id,
        actor_role: profile.role,
        detail: { stage: "coo", note: cleanNote },
      });
      await writeAudit({
        action: "delete_rejected",
        entityType: "action_request",
        entityId: requestId,
        actorUserId: profile.id,
        actorRole: profile.role,
        orgId: row.org_id,
        detail: { stage: "coo", ...(cleanNote ? { note: cleanNote } : {}) },
      });
      await notifyRequester(row, `The COO rejected your delete request${cleanNote ? ` — “${cleanNote}”` : "."}`, "Delete request rejected");
      revalidatePath("/approvals");
      return ok("Rejected. Nothing was deleted.");
    }

    // Approve → advance to the CEO.
    const { data: updated } = await svc
      .from("action_requests")
      .update({
        status: "pending_ceo",
        first_decision: "approved",
        first_decided_by: profile.id,
        first_decided_at: now,
        first_note: cleanNote,
        updated_at: now,
      })
      .eq("id", requestId)
      .eq("status", "pending_coo")
      .select("id")
      .maybeSingle();
    if (!updated) return fail("This request was already decided.");

    await writeActionAudit(svc, {
      org_id: row.org_id,
      action_request_id: requestId,
      event: "approved",
      actor_id: profile.id,
      actor_role: profile.role,
      detail: { stage: "coo", note: cleanNote },
    });
    await writeAudit({
      action: "delete_coo_approved",
      entityType: "action_request",
      entityId: requestId,
      actorUserId: profile.id,
      actorRole: profile.role,
      orgId: row.org_id,
      detail: { stage: "coo", ...(cleanNote ? { note: cleanNote } : {}) },
    });
    // Stage 2 approver: the CEO now decides — bell + Telegram.
    await notify({
      orgId: row.org_id,
      type: "governed_delete",
      severity: "warning",
      title: `Final delete sign-off needed · ${row.title}`,
      body: `The COO approved a permanent delete. As CEO your approval executes it — this cannot be undone.`,
      entityType: "action_request",
      entityId: requestId,
      roles: ["ceo"],
    });
    await sendTelegram(
      `✅ <b>COO approved a permanent delete</b>\n${escapeHtml(row.title)}\nAwaiting the CEO's final sign-off in Approvals.`
    );
    revalidatePath("/approvals");
    return ok("Approved. Sent to the CEO for final sign-off.");
  }

  // ── Stage 2 — CEO (final) ─────────────────────────────────────────────────────
  if (row.status === "pending_ceo") {
    if (profile.role !== "ceo") {
      return fail("Stage 2 requires the CEO — only the CEO can give final sign-off.");
    }

    if (decision === "rejected") {
      const { data: updated } = await svc
        .from("action_requests")
        .update({
          status: "rejected",
          final_decision: "rejected",
          final_decided_by: profile.id,
          final_decided_at: now,
          final_note: cleanNote,
          decided_by: profile.id,
          decided_at: now,
          updated_at: now,
        })
        .eq("id", requestId)
        .eq("status", "pending_ceo")
        .select("id")
        .maybeSingle();
      if (!updated) return fail("This request was already decided.");

      await writeActionAudit(svc, {
        org_id: row.org_id,
        action_request_id: requestId,
        event: "rejected",
        actor_id: profile.id,
        actor_role: profile.role,
        detail: { stage: "ceo", note: cleanNote },
      });
      await writeAudit({
        action: "delete_rejected",
        entityType: "action_request",
        entityId: requestId,
        actorUserId: profile.id,
        actorRole: profile.role,
        orgId: row.org_id,
        detail: { stage: "ceo", ...(cleanNote ? { note: cleanNote } : {}) },
      });
      await notifyRequester(row, `The CEO rejected your delete request${cleanNote ? ` — “${cleanNote}”` : "."}`, "Delete request rejected");
      revalidatePath("/approvals");
      return ok("Rejected. Nothing was deleted.");
    }

    // Final approve → move to 'approved', then run the executor (approved→executed).
    const { data: updated } = await svc
      .from("action_requests")
      .update({
        status: "approved",
        final_decision: "approved",
        final_decided_by: profile.id,
        final_decided_at: now,
        final_note: cleanNote,
        decided_by: profile.id,
        decided_at: now,
        updated_at: now,
      })
      .eq("id", requestId)
      .eq("status", "pending_ceo")
      .select("*")
      .maybeSingle();
    const approved = updated as ActionRequestRow | null;
    if (!approved) return fail("This request was already decided.");

    await writeActionAudit(svc, {
      org_id: row.org_id,
      action_request_id: requestId,
      event: "approved",
      actor_id: profile.id,
      actor_role: profile.role,
      detail: { stage: "ceo", note: cleanNote },
    });
    await writeAudit({
      action: "delete_ceo_approved",
      entityType: "action_request",
      entityId: requestId,
      actorUserId: profile.id,
      actorRole: profile.role,
      orgId: row.org_id,
      detail: { stage: "ceo", ...(cleanNote ? { note: cleanNote } : {}) },
    });

    // The ONE place a governed delete becomes real. Never throws.
    const exec = await executeGovernedDelete(approved);

    revalidatePath("/approvals");
    if (entity) for (const p of entity.revalidate) revalidatePath(p);

    if (exec.ok) {
      await notifyRequester(row, "Approved by the CEO and permanently deleted.", "Delete request executed");
      await sendTelegram(
        `🔥 <b>Permanent delete executed</b>\n${escapeHtml(row.title)} was permanently removed after the CEO's final approval.`
      );
      return ok("Approved and executed — the record was permanently deleted.");
    }
    // Approval stood, but the delete failed — surface it honestly.
    await notifyRequester(
      row,
      `Approved by the CEO, but the delete failed: ${exec.error ?? "unknown error"}.`,
      "Delete failed"
    );
    return fail(`Approved, but the delete failed: ${exec.error ?? "unknown error"}.`);
  }

  // Any other status is terminal — already decided/executed.
  return fail("This request has already been decided.");
}

// Tell the requester how their delete request ended. Best-effort (notify never
// throws); skipped when the request has no recorded requester.
async function notifyRequester(row: ActionRequestRow, body: string, title: string): Promise<void> {
  if (!row.created_by) return;
  await notify({
    orgId: row.org_id,
    type: "governed_delete",
    severity: "info",
    title: `${title} · ${row.title}`,
    body,
    entityType: "action_request",
    entityId: row.id,
    userIds: [row.created_by],
  });
}
