// lib/actions/audit.ts — one tiny writer for the action_audit trail, shared by
// the producer (system 'created'), the decide server action (human 'approved' /
// 'rejected') and the executor (system 'executed' / 'failed'). Every write
// stamps org_id so the aud_insert with_check (org_id = current_org_id()) passes
// for the RLS user client, and is a no-op-safe best effort — a failed audit
// insert never takes down the action it records.

// The action_audit table isn't in the generated Database types yet, so callers
// pass either a user (RLS) client or the service-role client through the same
// cast shim the rest of the module uses.
type Shim = { from: (t: string) => any };

export interface ActionAuditInput {
  org_id: string;
  action_request_id: string | null;
  // The action-spine events, plus the Policy Registry consult events written by
  // lib/governance/policy.ts (checkPolicy records denials + approvals here).
  event:
    | "created"
    | "approved"
    | "rejected"
    | "executed"
    | "failed"
    | "opportunity_received"
    | "policy_denied"
    | "policy_needs_approval"
    | "policy_allowed"
    // Security events (PASTE 3.2, Part B) — auth, data exports, and policy edits.
    // These share the same trail so leadership reviews everything in one place.
    | "login"
    | "failed_login"
    | "password_change"
    | "data_export"
    | "policy_change"
    // Expense-ledger events — create / edit / approve / pay / cancel share this
    // same trail so the immutable expense history lives beside the action spine.
    | "expense_created"
    | "expense_updated"
    | "expense_approved"
    | "expense_paid"
    | "expense_cancelled"
    // Edit + Soft-Archive lifecycle — a record edited in place, soft-archived
    // (archived_at/archived_by stamped), restored (both cleared), or hard-deleted
    // (leadership-only, irreversible). Shared across every user-facing cluster so
    // who touched what, when, is one queryable trail.
    | "record_edited"
    | "record_archived"
    | "record_restored"
    | "record_hard_deleted"
    // Manual automation override — a leadership user fired a job (products sync,
    // metrics rollup) by hand from the Settings → Automation panel instead of
    // waiting on the GitHub Actions schedule. A privileged action, so it leaves a trail.
    | "automation_run";
  actor_id: string | null; // null for system events
  actor_role: string | null; // 'system' for producer/executor, else the human role
  detail?: Record<string, unknown> | null;
}

export async function writeActionAudit(db: Shim, input: ActionAuditInput): Promise<void> {
  try {
    await db.from("action_audit").insert({
      org_id: input.org_id,
      action_request_id: input.action_request_id,
      event: input.event,
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      detail: input.detail ?? null,
    });
  } catch {
    // Recording the trail must never break the action it describes.
  }
}
