// lib/finance/expense-workflow.ts — the expense approval workflow's DOMAIN model.
//
// An expense moves through a fixed lifecycle:
//
//   encoded → finance_review → department_approval → management_approval
//           → ready_for_payment → paid → archived
//
// The three middle stages are APPROVAL GATES: leaving each one needs a human
// sign-off, and that sign-off is filed as a pending action_request through the
// EXISTING Action & Approval spine (source_module='expense'). There is NO
// parallel approver — the same queue, the same approve/hold path, the same
// action_audit trail that every other loop uses. Approving a gate's request runs
// the `advance_expense_stage` executor, which stamps the expense one stage
// forward and files the next gate's request (until ready_for_payment).
//
// MONEY GUARDRAIL: the OS NEVER moves money. management_approval → ready_for_payment
// only marks the expense payable; ready_for_payment → paid is a HUMAN recording a
// payment made OUTSIDE the OS (it only stamps paid_at). No stage executes a
// transfer, and this module encodes none.
//
// The expenses table isn't in the generated Database types, so callers read it
// through the app's cast shim and hand rows to these typed helpers.

import { peso } from "@/lib/metrics/format";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "@/lib/actions/types";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export type ExpenseStage =
  | "encoded"
  | "finance_review"
  | "department_approval"
  | "management_approval"
  | "ready_for_payment"
  | "paid"
  | "archived";

// The ordered lifecycle — index N advances to index N+1.
export const EXPENSE_STAGE_ORDER: ExpenseStage[] = [
  "encoded",
  "finance_review",
  "department_approval",
  "management_approval",
  "ready_for_payment",
  "paid",
  "archived",
];

// The stages that require a human sign-off (an action_request) to LEAVE. Each
// carries the role RLS lets decide its request.
export type ExpenseGate = "finance_review" | "department_approval" | "management_approval";

export const EXPENSE_GATES: ExpenseGate[] = [
  "finance_review",
  "department_approval",
  "management_approval",
];

export function isExpenseGate(stage: string | null | undefined): stage is ExpenseGate {
  return stage === "finance_review" || stage === "department_approval" || stage === "management_approval";
}

// The role that decides a given gate's request. finance_review + management_approval
// are leadership calls (ceo/coo, COO owns); department_approval additionally lets
// the owning department head approve. Mirrors action_requests' required_role
// semantics (see canDecide() in lib/actions/types.ts) so the UI and RLS agree.
export function requiredRoleForGate(gate: ExpenseGate): RequiredRole {
  return gate === "department_approval" ? "department_head" : "coo";
}

// The next stage after `stage`, or null at the end of the lifecycle.
export function nextExpenseStage(stage: ExpenseStage): ExpenseStage | null {
  const i = EXPENSE_STAGE_ORDER.indexOf(stage);
  if (i < 0 || i >= EXPENSE_STAGE_ORDER.length - 1) return null;
  return EXPENSE_STAGE_ORDER[i + 1];
}

// ── Coarse status (the expenses.status column) ────────────────────────────────
// The DB constrains status to a small set (expenses_status_check): the fine
// lifecycle detail lives in workflow_stage, so status is just a coarse bucket
// derived from it. A rejected gate KICKS THE EXPENSE BACK to 'encoded' (status
// 'pending') for correction and re-submission — there is no separate hold state.
export type ExpenseStatus = "pending" | "approved" | "paid" | "cancelled" | "archived";

export function statusForStage(stage: ExpenseStage): ExpenseStatus {
  switch (stage) {
    case "encoded":
    case "finance_review":
    case "department_approval":
    case "management_approval":
      return "pending";
    case "ready_for_payment":
      return "approved";
    case "paid":
      return "paid";
    case "archived":
      return "archived";
  }
}

// The expense type + payment method vocabularies, mirroring the DB CHECK
// constraints so the encode form never offers a value the row would reject.
export const EXPENSE_TYPES = ["OPEX", "CAPEX"] as const;
export const EXPENSE_PAYMENT_METHODS = [
  "cash",
  "bank_transfer",
  "gcash",
  "credit_card",
  "petty_cash",
  "other",
] as const;
export const EXPENSE_ALLOCATIONS = ["brand", "business_unit", "department", "shared"] as const;

// ── Presentation ──────────────────────────────────────────────────────────────

export const EXPENSE_STAGE_LABEL: Record<ExpenseStage, string> = {
  encoded: "Encoded",
  finance_review: "Finance review",
  department_approval: "Department approval",
  management_approval: "Management approval",
  ready_for_payment: "Ready for payment",
  paid: "Paid",
  archived: "Archived",
};

export function expenseStageLabel(stage: string | null | undefined): string {
  return stage ? EXPENSE_STAGE_LABEL[stage as ExpenseStage] ?? stage : "—";
}

// A short human sentence for the gate an approver is deciding.
export const EXPENSE_GATE_DESCRIPTION: Record<ExpenseGate, string> = {
  finance_review: "Finance reviews the coding, amounts and supporting reference before it advances.",
  department_approval: "The owning department head confirms the spend is theirs and justified.",
  management_approval: "Management gives the final sign-off before the expense becomes payable.",
};

// ── The drafted action_request for one gate ───────────────────────────────────
// The full payload minus org_id / created_by / status (the caller stamps those
// so the RLS with_check passes). This is what lands in the Approval Queue.
export interface ExpenseGateDraft {
  source_module: "expense";
  source_ref: { expense_id: string };
  title: string;
  problem: string;
  root_cause: string;
  evidence: EvidenceFact[];
  options: ActionOption[];
  recommendation: string;
  estimated_impact: EstimatedImpact;
  confidence: number | null;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: ProposedAction;
}

// The expense facts the draft needs. All optional except id/amount so a sparsely
// encoded expense still produces an honest card (unknowns show as em-dashes).
export interface ExpenseForDraft {
  id: string;
  expense_code?: string | null;
  transaction_date?: string | null;
  type?: string | null;
  allocation?: string | null;
  gross_amount?: number | null;
  vat_amount?: number | null;
  net_amount?: number | null;
  reference_number?: string | null;
  payment_method?: string | null;
  remarks?: string | null;
  brand_id?: string | null;
  department_id?: string | null;
}

// A short label for the expense in a title: its code, else a shortened id.
export function expenseTitleLabel(exp: ExpenseForDraft): string {
  const code = (exp.expense_code ?? "").trim();
  if (code) return code;
  return `Expense ${exp.id.slice(0, 8)}`;
}

// Money-tier: an expense sign-off is a consequential financial decision, so it
// draws L3 (High). Kept a constant so the copy and the tier never drift.
export const EXPENSE_RISK_TIER = 3;

// Build the action_request draft for the gate `gate`, which the expense is
// currently sitting at. Approving it advances the expense to nextExpenseStage(gate).
// `vendorLabel` / `brandName` / `departmentName` are resolved by the caller (the
// approver — especially a department head — can't read the expenses table under
// RLS, so every fact the decision needs is carried on the card).
export function buildExpenseGateDraft(params: {
  expense: ExpenseForDraft;
  gate: ExpenseGate;
  vendorLabel?: string | null;
  brandName?: string | null;
  departmentName?: string | null;
}): ExpenseGateDraft {
  const { expense, gate } = params;
  const to = nextExpenseStage(gate);
  // A gate always has a next stage; fall back defensively so the type is total.
  const toStage: ExpenseStage = to ?? "ready_for_payment";

  const label = expenseTitleLabel(expense);
  const gross = expense.gross_amount != null ? Number(expense.gross_amount) : null;
  const vendor = (params.vendorLabel ?? "").trim() || null;
  const scope =
    (params.brandName ?? "").trim() ||
    (params.departmentName ?? "").trim() ||
    (expense.allocation ?? "").trim() ||
    null;

  const amountLabel = gross != null ? peso(gross) : "an unstated amount";
  const who = vendor ? ` to ${vendor}` : "";
  const forScope = scope ? ` for ${scope}` : "";

  const problem =
    `${label} — ${amountLabel}${who}${forScope} — is at the ${EXPENSE_STAGE_LABEL[gate]} gate and ` +
    `needs a sign-off to advance to ${EXPENSE_STAGE_LABEL[toStage]}.`;

  const root_cause = EXPENSE_GATE_DESCRIPTION[gate];

  const evidence: EvidenceFact[] = [
    { label: "Gross amount", value: gross != null ? peso(gross) : "—" },
    { label: "VAT", value: expense.vat_amount != null ? peso(Number(expense.vat_amount)) : "—" },
    { label: "Net", value: expense.net_amount != null ? peso(Number(expense.net_amount)) : "—" },
    { label: "Vendor", value: vendor ?? "—" },
    { label: "Reference #", value: (expense.reference_number ?? "").trim() || "— (none on file)" },
    { label: "Type", value: (expense.type ?? "").trim() || "—" },
    { label: "Allocation", value: scope ?? "—" },
    { label: "Transaction date", value: (expense.transaction_date ?? "").trim() || "—" },
  ];
  if ((expense.remarks ?? "").trim()) {
    evidence.push({ label: "Remarks", value: (expense.remarks as string).trim() });
  }

  const options: ActionOption[] = [
    {
      label: `Approve — advance to ${EXPENSE_STAGE_LABEL[toStage]}`,
      tradeoff:
        toStage === "ready_for_payment"
          ? "Marks the expense payable. It does NOT pay anything — payment is recorded by a human, outside the OS."
          : "Moves it to the next sign-off. Each gate keeps a separate human in the loop.",
    },
    {
      label: "Hold / reject",
      tradeoff:
        "Puts the expense on hold at this gate for a correction or a query. It stays visible where it stalled; nothing advances.",
    },
  ];

  const recommendation =
    gate === "finance_review"
      ? "Confirm the coding, amounts and supporting reference are correct, then approve to route to the department head."
      : gate === "department_approval"
        ? "Confirm this spend belongs to your department and is justified, then approve to route to management."
        : "Give the final sign-off. Approval marks it ready for payment — a human still records the actual payment.";

  return {
    source_module: "expense",
    source_ref: { expense_id: expense.id },
    title: `Expense sign-off: ${label} — ${amountLabel}${who}`,
    problem,
    root_cause,
    evidence,
    options,
    recommendation,
    estimated_impact: {
      summary:
        toStage === "ready_for_payment"
          ? `Clears ${label} for payment. The OS records — it never pays.`
          : `Advances ${label} to ${EXPENSE_STAGE_LABEL[toStage]}.`,
      gap_value: gross,
      gap_unit: "PHP",
      is_money: true,
    },
    // This is a human workflow gate, not an AI diagnosis, so there's no
    // confidence to assert — honest null rather than an invented number.
    confidence: null,
    risk_tier: EXPENSE_RISK_TIER,
    required_role: requiredRoleForGate(gate),
    proposed_action: {
      type: "advance_expense_stage",
      payload: { expense_id: expense.id, from_stage: gate, to_stage: toStage },
    },
  };
}
