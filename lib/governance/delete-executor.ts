// lib/governance/delete-executor.ts — the EXECUTOR for the governed
// permanent-delete gate. It is the ONE place a governed hard-delete becomes a
// real row deletion, and it runs ONLY after BOTH approvals (COO then CEO) have
// landed and the request has been moved to 'approved' by the decision action.
//
// Contract (mirrors lib/actions/executor.ts):
//   • runs ONLY on the approved→executed transition — it refuses any request
//     whose status is not 'approved', so it can never fire on a still-pending or
//     already-executed row.
//   • hard-deletes ONLY for proposed_action.type='hard_delete' and ONLY for a
//     whitelisted entity — an unknown type or entity is refused BEFORE any write.
//   • service-role client, because a permanent delete must work uniformly across
//     tables regardless of whether they carry an RLS DELETE policy (the two-role
//     approval chain is the authority here), and is always org-scoped + audited.
//   • never throws — every failure is caught, recorded as status='failed' + error
//     and a 'failed' audit row, and returned as { ok:false }.
//   • generic dispatch on entity: 'task' now; brands / finance / … later add only
//     a registry entry (see delete-entities.ts).

import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import { writeAudit } from "@/lib/audit/log";
import { governedDeleteEntity, parseHardDelete, type DependentTable } from "./delete-entities";
import type { ActionRequestRow } from "@/lib/actions/types";

type Shim = { from: (t: string) => any };

export interface GovExecResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

// Clear a level of dependents (and, recursively, their blocking grandchildren)
// before the parent row is deleted — FK order, org-scoped, inside the already-
// approved execution. `parentIds` are the ids of the rows one level up (the top
// call passes [targetId]).
//
// For a dependent that has ITS OWN blocking children, we first resolve that
// dependent's ids for the current parents, recurse to clear the grandchildren,
// then delete the dependent rows. A dependent with no nested children is deleted
// directly. Every step is `.in(column, parentIds)` so a single query covers all
// parents at that level. Any DB error throws → the caller records a FAILED
// execution (never a partial silent state).
async function clearDependents(
  db: Shim,
  deps: DependentTable[] | undefined,
  parentIds: string[],
  orgId: string,
  trail: { table: string; column: string; via?: string }[]
): Promise<void> {
  if (!deps || deps.length === 0 || parentIds.length === 0) return;

  for (const dep of deps) {
    if (dep.dependents && dep.dependents.length > 0) {
      // Resolve this dependent's ids for the current parents, then clear its
      // blocking grandchildren before deleting it.
      const { data: rows, error: selErr } = await db
        .from(dep.table)
        .select("id")
        .in(dep.column, parentIds)
        .eq("org_id", orgId);
      if (selErr) {
        throw new Error(
          selErr.message || `Could not read ${dep.table} to clear its nested dependents.`
        );
      }
      const childIds = ((rows ?? []) as { id: string | null }[])
        .map((r) => r.id)
        .filter((v): v is string => !!v);
      await clearDependents(db, dep.dependents, childIds, orgId, trail);
    }

    const { error: delErr } = await db
      .from(dep.table)
      .delete()
      .in(dep.column, parentIds)
      .eq("org_id", orgId);
    if (delErr) {
      throw new Error(
        delErr.message || `Could not clear dependent ${dep.table} before deleting the parent.`
      );
    }
    trail.push({ table: dep.table, column: dep.column });
  }
}

// Execute an already-fully-approved governed delete. The caller MUST have moved
// the request to 'approved' first (the CEO's final sign-off); this only performs
// the machine step and stamps the terminal state.
export async function executeGovernedDelete(request: ActionRequestRow): Promise<GovExecResult> {
  const db = createServiceRoleClient() as unknown as Shim;

  try {
    // Guard 1: only the approved→executed transition. Never delete on any other
    // state (pending_coo / pending_ceo / rejected / executed / failed).
    if (request.status !== "approved") {
      throw new Error(`Refusing to execute a governed delete in state "${request.status}".`);
    }

    // Guard 2: a well-formed hard_delete for a whitelisted entity, or refuse
    // BEFORE touching any table.
    const action = parseHardDelete(request.proposed_action);
    if (!action) {
      throw new Error("Not a governed hard_delete for a known entity.");
    }
    const entity = governedDeleteEntity(action.entity);
    if (!entity) {
      throw new Error(`No governed-delete executor for entity "${action.entity}".`);
    }

    // Clear dependent child rows FIRST (FK order), org-scoped, so the parent
    // delete can't be blocked by a NO ACTION referencing row. Nested chains
    // (e.g. creator → anchors → live_sessions) are handled recursively. A failure
    // here surfaces as a failed execution — never a partial silent state.
    const clearedDependents: { table: string; column: string; via?: string }[] = [];
    await clearDependents(db, entity.dependents, [action.id], request.org_id, clearedDependents);

    // The one irreversible act — org-scoped, service-role. If the row is still
    // referenced by others the DB may reject it; that surfaces as a failed
    // execution, never a silent no-op.
    const { error: delErr } = await db
      .from(entity.table)
      .delete()
      .eq("id", action.id)
      .eq("org_id", request.org_id);
    if (delErr) {
      throw new Error(delErr.message || "Could not delete — it may be referenced by other records.");
    }

    const result: Record<string, unknown> = {
      kind: "hard_delete",
      entity: action.entity,
      table: entity.table,
      id: action.id,
      ...(clearedDependents.length ? { dependents: clearedDependents } : {}),
    };

    const executedAt = new Date().toISOString();
    await db
      .from("action_requests")
      .update({
        status: "executed",
        executed_at: executedAt,
        execution_result: result,
        error: null,
        updated_at: executedAt,
      })
      .eq("id", request.id);

    // Two audit rows: the generic 'executed' event (parity with the action spine)
    // plus the specific 'record_hard_deleted' so the delete is greppable in the
    // one shared trail every other cluster's hard-delete writes to.
    await writeActionAudit(db, {
      org_id: request.org_id,
      action_request_id: request.id,
      event: "executed",
      actor_id: null,
      actor_role: "system",
      detail: { decided_by: request.final_decided_by ?? request.decided_by, result },
    });
    await writeActionAudit(db, {
      org_id: request.org_id,
      action_request_id: request.id,
      event: "record_hard_deleted",
      actor_id: null,
      actor_role: "system",
      detail: { entity: action.entity, table: entity.table, id: action.id },
    });

    // Privileged-action trail: the terminal step of the governed-delete
    // lifecycle. A system step (no session actor) — actor_role defaults to
    // 'system'; the deciding CEO is carried in detail.
    await writeAudit({
      action: "delete_executed",
      entityType: "action_request",
      entityId: request.id,
      actorUserId: null,
      actorRole: "system",
      orgId: request.org_id,
      detail: {
        entity: action.entity,
        table: entity.table,
        target_id: action.id,
        decided_by: request.final_decided_by ?? request.decided_by,
      },
    });

    return { ok: true, result };
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const ts = new Date().toISOString();
    try {
      await db
        .from("action_requests")
        .update({ status: "failed", error: message, updated_at: ts })
        .eq("id", request.id);
      await writeActionAudit(db, {
        org_id: request.org_id,
        action_request_id: request.id,
        event: "failed",
        actor_id: null,
        actor_role: "system",
        detail: { error: message },
      });
    } catch {
      // Even failure-recording is best effort — never throw out of the executor.
    }
    return { ok: false, error: message };
  }
}
