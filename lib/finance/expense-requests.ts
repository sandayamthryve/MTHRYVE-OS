// lib/finance/expense-requests.ts — the ONE place an expense gate's sign-off is
// filed into the Action & Approval spine.
//
// Filing a gate = INSERT one pending action_requests row (source_module='expense',
// source_ref={expense_id}) + a 'created' action_audit row + a pending_approval
// notification to exactly the roles RLS lets decide it. This is the SAME
// approve/hold path every other loop uses — there is no parallel approver.
//
// It's shared by two callers: the `submitExpense` server action (files the first
// gate, finance_review, as the RLS user) and the advance_expense_stage executor
// (files the next gate on approval, as the service role). Both flow through here
// so the drafted card, the audit trail and the notification never drift.

import { writeActionAudit } from "@/lib/actions/audit";
import { notifyPendingApproval } from "@/lib/notifications/producers";
import {
  buildExpenseGateDraft,
  requiredRoleForGate,
  type ExpenseGate,
  type ExpenseForDraft,
} from "@/lib/finance/expense-workflow";

type Shim = { from: (t: string) => any };

// The expense facts needed to file a gate. Names are resolved here (from brand /
// department / vendor rows) so the approver's card carries every fact — a
// department head can't read the expenses table under RLS, so the request must
// stand alone.
export interface FileExpenseGateInput {
  orgId: string;
  createdBy: string | null;
  gate: ExpenseGate;
  expense: ExpenseForDraft & { vendor_id?: string | null; vendor_name_oneoff?: string | null };
}

// Resolve a human label for the expense's brand, department and vendor. Best
// effort: an unresolved id just yields null and the card shows an em-dash.
async function resolveLabels(
  db: Shim,
  expense: FileExpenseGateInput["expense"]
): Promise<{ brandName: string | null; departmentName: string | null; vendorLabel: string | null }> {
  const [brand, dept, vendor] = await Promise.all([
    expense.brand_id
      ? db.from("brands").select("name").eq("id", expense.brand_id).maybeSingle()
      : Promise.resolve({ data: null }),
    expense.department_id
      ? db.from("departments").select("name").eq("id", expense.department_id).maybeSingle()
      : Promise.resolve({ data: null }),
    expense.vendor_id
      ? db.from("vendors").select("name").eq("id", expense.vendor_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const vendorLabel =
    ((vendor?.data as { name?: string } | null)?.name ?? "").trim() ||
    (expense.vendor_name_oneoff ?? "").trim() ||
    null;
  return {
    brandName: ((brand?.data as { name?: string } | null)?.name ?? "").trim() || null,
    departmentName: ((dept?.data as { name?: string } | null)?.name ?? "").trim() || null,
    vendorLabel,
  };
}

// File the gate. Returns the new action_request id, or null if the INSERT failed
// (RLS rejected, or a DB error). The audit + notification are best-effort and
// never fail the caller. On a null return the caller should surface an error and
// NOT treat the expense as having advanced past this gate.
export async function fileExpenseGateRequest(
  db: Shim,
  input: FileExpenseGateInput
): Promise<string | null> {
  const { brandName, departmentName, vendorLabel } = await resolveLabels(db, input.expense);

  const draft = buildExpenseGateDraft({
    expense: input.expense,
    gate: input.gate,
    vendorLabel,
    brandName,
    departmentName,
  });

  const { data: inserted, error } = await db
    .from("action_requests")
    .insert({
      org_id: input.orgId,
      created_by: input.createdBy,
      status: "pending",
      ...draft,
    })
    .select("id")
    .single();

  const requestId = (inserted as { id?: string } | null)?.id ?? null;
  if (error || !requestId) return null;

  await writeActionAudit(db, {
    org_id: input.orgId,
    action_request_id: requestId,
    event: "created",
    actor_id: null,
    actor_role: "system",
    detail: {
      source: "expense_workflow",
      expense_id: input.expense.id,
      gate: input.gate,
      required_role: requiredRoleForGate(input.gate),
    },
  });

  await notifyPendingApproval({
    orgId: input.orgId,
    title: draft.title,
    body: draft.problem,
    requiredRole: requiredRoleForGate(input.gate),
    actionRequestId: requestId,
    severity: "info",
  });

  return requestId;
}
