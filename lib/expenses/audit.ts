// lib/expenses/audit.ts — the append-only audit writer for the Expense ledger.
//
// Every create / edit / approve / pay / cancel on an expense lands as a row on
// the SHARED public.action_audit trail (the same table the action spine and
// security events use). No schema change is needed: `event` is free text and
// action_audit is append-only by RLS (INSERT + SELECT policies only — no UPDATE
// or DELETE), so a written row is immutable. The Expense audit view reads back
// the rows whose event starts with `expense_`.
//
// The `detail` jsonb carries the expense id, its code, and — for an edit — the
// before/after values of exactly the fields that changed, so a reviewer can see
// what was altered without a second query. It never carries anything RLS
// wouldn't already show a ceo/coo reader.

import { writeActionAudit } from "@/lib/actions/audit";
import type { Db, ExpenseAuditEvent, ExpenseRow } from "./types";
import { EXPENSE_AUDIT_EVENTS } from "./types";

// The subset of expense columns worth diffing on an edit. Approval/payment
// stamps are recorded via their own events, so they're excluded from the edit
// diff to keep it to substantive field changes.
const DIFF_FIELDS: (keyof ExpenseRow)[] = [
  "transaction_date",
  "type",
  "category_id",
  "allocation",
  "brand_id",
  "department_id",
  "reference_number",
  "vendor_id",
  "vendor_name_oneoff",
  "gross_amount",
  "vat_amount",
  "net_amount",
  "payment_method",
  "status",
  "workflow_stage",
  "remarks",
];

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

// Compute the before/after changes between two expense snapshots. Numeric
// columns are compared by value so "100" vs 100 isn't a false change.
export function diffExpense(
  before: Partial<ExpenseRow>,
  after: Partial<ExpenseRow>
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const f of DIFF_FIELDS) {
    const a = before[f];
    const b = after[f];
    const equal =
      typeof a === "number" || typeof b === "number"
        ? Number(a ?? NaN) === Number(b ?? NaN) || (a == null && b == null)
        : (a ?? null) === (b ?? null);
    if (!equal) changes.push({ field: f as string, from: a ?? null, to: b ?? null });
  }
  return changes;
}

export interface WriteExpenseAuditInput {
  orgId: string;
  event: ExpenseAuditEvent;
  // Null for system/service events (e.g. the executor advancing a stage when the
  // decider isn't stamped) — maps to the nullable action_audit.actor_id.
  actorId: string | null;
  actorRole: string | null;
  expenseId: string;
  expenseCode: string | null;
  // For edits: the field-level before/after. For create: the created snapshot.
  changes?: FieldChange[];
  snapshot?: Record<string, unknown>;
  note?: string | null;
}

// Append one immutable audit row for an expense event. Best-effort: a failed
// audit insert never takes down the ledger operation it records (writeActionAudit
// swallows errors). action_request_id is null — an expense isn't an action-spine
// request; the expense id lives in `detail` instead.
export async function writeExpenseAudit(db: Db, input: WriteExpenseAuditInput): Promise<void> {
  await writeActionAudit(db as any, {
    org_id: input.orgId,
    action_request_id: null,
    event: input.event,
    actor_id: input.actorId,
    actor_role: input.actorRole,
    detail: {
      module: "expenses",
      expense_id: input.expenseId,
      expense_code: input.expenseCode,
      ...(input.changes ? { changes: input.changes } : {}),
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      ...(input.note ? { note: input.note } : {}),
    },
  });
}

// --- Audit reader -----------------------------------------------------------

export interface ExpenseAuditRow {
  id: string;
  event: ExpenseAuditEvent;
  actor_id: string | null;
  actor_role: string | null;
  created_at: string;
  expense_id: string | null;
  expense_code: string | null;
  changes: FieldChange[] | null;
  snapshot: Record<string, unknown> | null;
  note: string | null;
}

// Read back the immutable expense audit trail, newest first. action_audit is
// org-scoped by RLS; the caller (ceo/coo audit view) is what gates the read to
// leadership. `expenseId` narrows to one expense's history. The `event`-prefix
// filter keeps this to expense events, separate from the action spine and
// security rows that share the table.
export async function loadExpenseAudit(
  db: Db,
  opts: { expenseId?: string; limit?: number } = {}
): Promise<ExpenseAuditRow[]> {
  let query = db
    .from("action_audit")
    .select("id, event, actor_id, actor_role, detail, created_at")
    .in("event", EXPENSE_AUDIT_EVENTS as unknown as string[]);
  if (opts.expenseId) query = query.eq("detail->>expense_id", opts.expenseId);
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 200);

  const rows = (data ?? []) as Array<{
    id: string;
    event: ExpenseAuditEvent;
    actor_id: string | null;
    actor_role: string | null;
    detail: Record<string, unknown> | null;
    created_at: string;
  }>;

  return rows.map((r) => {
    const d = r.detail ?? {};
    return {
      id: r.id,
      event: r.event,
      actor_id: r.actor_id,
      actor_role: r.actor_role,
      created_at: r.created_at,
      expense_id: (d.expense_id as string) ?? null,
      expense_code: (d.expense_code as string) ?? null,
      changes: (d.changes as FieldChange[]) ?? null,
      snapshot: (d.snapshot as Record<string, unknown>) ?? null,
      note: (d.note as string) ?? null,
    };
  });
}
