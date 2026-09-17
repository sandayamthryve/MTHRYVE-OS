// lib/expenses/types.ts — the shared vocabulary for the Expense module.
//
// One home for the expense enums (mirrored from the DB CHECK constraints on
// public.expenses / expense_categories / budgets), the row shapes the readers
// return, and the human labels every surface renders. Keeping the allowed values
// here — identical to the constraints — means the encode form, the filter bar
// and the export routes can never offer an option the database would reject.

import type { UserRole } from "@/types/database";

// --- Enums (exact mirror of the DB CHECK constraints) -----------------------

export const EXPENSE_TYPES = ["OPEX", "CAPEX"] as const;
export type ExpenseType = (typeof EXPENSE_TYPES)[number];

export const EXPENSE_STATUSES = ["pending", "approved", "paid", "cancelled", "archived"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const WORKFLOW_STAGES = [
  "encoded",
  "finance_review",
  "department_approval",
  "management_approval",
  "ready_for_payment",
  "paid",
  "archived",
] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const PAYMENT_METHODS = [
  "cash",
  "bank_transfer",
  "gcash",
  "credit_card",
  "petty_cash",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ALLOCATIONS = ["brand", "business_unit", "department", "shared"] as const;
export type Allocation = (typeof ALLOCATIONS)[number];

export const CATEGORY_GROUPS = [
  "Administrative",
  "Marketing",
  "Operations",
  "Human Resources",
  "Finance",
] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

// --- Human labels -----------------------------------------------------------

export const STATUS_LABEL: Record<ExpenseStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  paid: "Paid",
  cancelled: "Cancelled",
  archived: "Archived",
};

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank Transfer",
  gcash: "GCash",
  credit_card: "Credit Card",
  petty_cash: "Petty Cash",
  other: "Other",
};

export const ALLOCATION_LABEL: Record<Allocation, string> = {
  brand: "Brand",
  business_unit: "Business Unit",
  department: "Department",
  shared: "Shared",
};

export const STAGE_LABEL: Record<WorkflowStage, string> = {
  encoded: "Encoded",
  finance_review: "Finance Review",
  department_approval: "Department Approval",
  management_approval: "Management Approval",
  ready_for_payment: "Ready for Payment",
  paid: "Paid",
  archived: "Archived",
};

// --- Type guards for untrusted input (query params, form fields) -------------

export const isExpenseType = (v: unknown): v is ExpenseType =>
  typeof v === "string" && (EXPENSE_TYPES as readonly string[]).includes(v);
export const isExpenseStatus = (v: unknown): v is ExpenseStatus =>
  typeof v === "string" && (EXPENSE_STATUSES as readonly string[]).includes(v);
export const isPaymentMethod = (v: unknown): v is PaymentMethod =>
  typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);
export const isAllocation = (v: unknown): v is Allocation =>
  typeof v === "string" && (ALLOCATIONS as readonly string[]).includes(v);
export const isWorkflowStage = (v: unknown): v is WorkflowStage =>
  typeof v === "string" && (WORKFLOW_STAGES as readonly string[]).includes(v);

// --- Row shapes -------------------------------------------------------------
// The expense tables aren't in the generated Database types, so the whole module
// reads/writes through this cast shim — the same pattern the Finance, Live and
// Contracts modules use.
export type Db = { from: (t: string) => any };

// A raw expenses row as stored (money columns come back as strings/numbers from
// PostgREST; the readers normalise to number|null).
export interface ExpenseRow {
  id: string;
  org_id: string;
  expense_code: string | null;
  transaction_date: string;
  type: ExpenseType;
  category_id: string | null;
  allocation: Allocation;
  brand_id: string | null;
  department_id: string | null;
  // Optional campaign this spend belongs to. Most expenses carry none — it is
  // the dimension "cost per campaign" groups by, not a required coding field.
  campaign_id: string | null;
  reference_number: string | null;
  vendor_id: string | null;
  vendor_name_oneoff: string | null;
  gross_amount: number;
  vat_amount: number;
  net_amount: number | null;
  payment_method: PaymentMethod | null;
  status: ExpenseStatus;
  workflow_stage: WorkflowStage | null;
  remarks: string | null;
  encoded_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  paid_at: string | null;
  date_encoded: string;
  created_at: string;
  updated_at: string;
}

export interface CategoryRow {
  id: string;
  group_name: CategoryGroup;
  name: string;
  gl_code: string | null;
  active: boolean;
  sort_order: number;
}

export interface VendorRow {
  id: string;
  name: string;
  vat_registered: boolean;
  active: boolean;
}

export interface BudgetRow {
  id: string;
  scope: "org" | "brand" | "department";
  brand_id: string | null;
  department_id: string | null;
  period: string;
  annual_budget: number | null;
  monthly_budget: number | null;
}

export interface NamedRef {
  id: string;
  name: string;
}

// An expense joined with the display names its row needs — assembled in JS from
// the lookup maps (no PostgREST embedding, so a missing FK never drops the row).
export interface ExpenseView extends ExpenseRow {
  category_name: string | null;
  category_group: CategoryGroup | null;
  vendor_display: string | null; // linked vendor name, else the one-off name
  brand_name: string | null;
  department_name: string | null;
  campaign_name: string | null;
  encoder_name: string | null;
  approver_name: string | null;
}

// Who may write which expense operation. Mirrors the RLS policies exactly so the
// UI never shows a control the database would reject:
//   INSERT (encode) → coo only
//   UPDATE (edit / approve / pay) → ceo or coo
export const canEncodeExpense = (role: UserRole): boolean => role === "coo";
export const canManageExpense = (role: UserRole): boolean => role === "ceo" || role === "coo";

// --- Audit event vocabulary --------------------------------------------------
// New free-text values on the shared action_audit.event column (no CHECK there),
// so the Expense trail lives beside the action spine and security events. The
// audit view filters on the `expense_` prefix.
export const EXPENSE_AUDIT_EVENTS = [
  "expense_created",
  "expense_updated",
  "expense_approved",
  "expense_paid",
  "expense_cancelled",
] as const;
export type ExpenseAuditEvent = (typeof EXPENSE_AUDIT_EVENTS)[number];

export const AUDIT_EVENT_LABEL: Record<ExpenseAuditEvent, string> = {
  expense_created: "Created",
  expense_updated: "Edited",
  expense_approved: "Approved",
  expense_paid: "Marked paid",
  expense_cancelled: "Cancelled",
};
