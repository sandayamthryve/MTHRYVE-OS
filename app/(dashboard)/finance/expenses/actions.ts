"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { statusForStage, expenseTitleLabel } from "@/lib/finance/expense-workflow";
import { fileExpenseGateRequest } from "@/lib/finance/expense-requests";
import { checkExpenseHygiene, runBudgetAlerts } from "@/lib/finance/expense-alerts";
import { diffExpense, writeExpenseAudit } from "@/lib/expenses/audit";
import {
  isAllocation,
  isExpenseType,
  isPaymentMethod,
  canManageExpense,
  type Db,
  type ExpenseRow,
} from "@/lib/expenses/types";

// The ONE server-action module for the expense lifecycle. It reconciles F2's
// approval workflow with F3's edit + audit, reusing the shared Action & Approval
// spine — there is NO parallel approver:
//
//   encode (POST /api/finance/expenses — evidence upload + create)      [F1]
//     → submit         encoded → finance_review, files the first gate    [F2]
//       → [approve in the Approval Queue → advance_expense_stage exec]   [F2]
//         → ready_for_payment → record payment (human stamp)             [F2]
//           → archived                                                   [F2]
//   edit / cancel are allowed ONLY at 'encoded' (pre-submission), so an
//   expense in the approval chain is never mutated underneath its request. [F3]
//
// Every mutation appends to the immutable action_audit trail (F3 audit view):
//   encode → expense_created (in the route) · edit → expense_updated ·
//   approve/advance → expense_approved (in the executor) · pay → expense_paid ·
//   cancel → expense_cancelled.
//
// Each action ends by redirecting to the records page with a flash message, so
// the whole surface is server-rendered (only the encode form is a client island).
// RLS is the real authority: expenses UPDATE is ceo/coo; the workflow writes are
// gated to a matching set. MONEY GUARDRAIL: recordExpensePayment only STAMPS
// paid_at — the OS never moves money.

type Shim = { from: (t: string) => any };

// Redirect back to the records view with a flash banner. `never` return keeps the
// callers total (redirect() throws NEXT_REDIRECT).
function flash(kind: "ok" | "err", msg: string): never {
  redirect(`/finance/expenses/records?flash=${kind}&msg=${encodeURIComponent(msg)}`);
}

function num(v: FormDataEntryValue | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}
function nullable(v: FormDataEntryValue | null): string | null {
  const s = str(v);
  return s === "" ? null : s;
}

const EXPENSE_SELECT =
  "id, org_id, expense_code, transaction_date, type, category_id, allocation, brand_id, department_id, campaign_id, " +
  "reference_number, vendor_id, vendor_name_oneoff, gross_amount, vat_amount, net_amount, payment_method, " +
  "status, workflow_stage, remarks, encoded_by, approved_by, approved_at, paid_at, date_encoded, created_at, updated_at";

// ── Submit: encoded → finance_review + file the first gate request. ceo/coo. ────
export async function submitExpense(formData: FormData): Promise<never> {
  const profile = (await requireRole(["ceo", "coo"])) as unknown as { id: string; org_id: string };
  const db = createServerSupabaseClient() as unknown as Shim;
  const id = str(formData.get("id"));
  if (!id) flash("err", "Missing expense.");

  const { data: current } = await db.from("expenses").select(EXPENSE_SELECT).eq("id", id).maybeSingle();
  const expense = current as
    | (Record<string, unknown> & { id: string; workflow_stage: string | null; status: string | null })
    | null;
  if (!expense) flash("err", "Expense not found.");
  const stage = (expense.workflow_stage as string | null) ?? "encoded";
  if (stage !== "encoded") flash("err", `This expense is already at ${stage.replace(/_/g, " ")}.`);

  const now = new Date().toISOString();
  const { error: updErr } = await db
    .from("expenses")
    .update({ workflow_stage: "finance_review", status: statusForStage("finance_review"), updated_at: now })
    .eq("id", id);
  if (updErr) flash("err", updErr.message);

  const requestId = await fileExpenseGateRequest(db, {
    orgId: profile.org_id,
    createdBy: profile.id,
    gate: "finance_review",
    expense: {
      id: expense.id,
      expense_code: expense.expense_code as string | null,
      transaction_date: expense.transaction_date as string | null,
      type: expense.type as string | null,
      allocation: expense.allocation as string | null,
      gross_amount: expense.gross_amount as number | null,
      vat_amount: expense.vat_amount as number | null,
      net_amount: expense.net_amount as number | null,
      reference_number: expense.reference_number as string | null,
      payment_method: expense.payment_method as string | null,
      remarks: expense.remarks as string | null,
      brand_id: expense.brand_id as string | null,
      department_id: expense.department_id as string | null,
      vendor_id: expense.vendor_id as string | null,
      vendor_name_oneoff: expense.vendor_name_oneoff as string | null,
    },
  });

  if (!requestId) {
    // Filing the sign-off failed — roll the stage back so the expense isn't
    // stranded in review with nothing in the queue.
    await db
      .from("expenses")
      .update({ workflow_stage: "encoded", status: statusForStage("encoded"), updated_at: new Date().toISOString() })
      .eq("id", id);
    flash("err", "Could not file the approval request. The expense was left as encoded.");
  }

  // Re-check hygiene now that it's entering review, and refresh budget alerts.
  await checkExpenseHygiene(db, profile.org_id, {
    id: expense.id,
    expenseLabel: expenseTitleLabel({ id: expense.id, expense_code: expense.expense_code as string | null }),
    reference_number: expense.reference_number as string | null,
    amountLabel: expense.gross_amount != null ? peso(Number(expense.gross_amount)) : null,
  });
  await runBudgetAlerts(db, profile.org_id);

  revalidatePath("/finance/expenses/records");
  revalidatePath("/approvals");
  flash("ok", "Submitted for finance review.");
}

// ── Edit: correct an expense BEFORE it is submitted (stage 'encoded' only). ─────
// ceo/coo. Records the field-level before/after on the immutable trail. Never
// writes net_amount (a GENERATED column) or the DB-owned expense_code.
export async function updateExpense(formData: FormData): Promise<never> {
  const profile = await requireProfile();
  if (!canManageExpense(profile.role)) flash("err", "You cannot edit expenses.");
  const db = createServerSupabaseClient() as unknown as Shim;

  const id = str(formData.get("id"));
  if (!id) flash("err", "Missing expense.");

  const { data: currentData } = await db.from("expenses").select(EXPENSE_SELECT).eq("id", id).maybeSingle();
  const before = currentData as ExpenseRow | null;
  if (!before) flash("err", "Expense not found.");
  if ((before.workflow_stage ?? "encoded") !== "encoded") {
    flash(
      "err",
      "Only an encoded (not-yet-submitted) expense can be edited. Reject it in the queue to send it back for correction."
    );
  }

  // Validate the mutable fields (net_amount is intentionally absent — it's
  // generated by the DB from gross − VAT).
  const transaction_date = str(formData.get("transaction_date"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction_date)) flash("err", "A valid transaction date is required.");
  const typeRaw = str(formData.get("type")).toUpperCase();
  if (!isExpenseType(typeRaw)) flash("err", "Type must be OPEX or CAPEX.");
  const allocationRaw = str(formData.get("allocation")) || "brand";
  if (!isAllocation(allocationRaw)) flash("err", "Invalid allocation.");
  const gross = num(formData.get("gross_amount"));
  if (!(gross > 0)) flash("err", "Gross amount must be greater than zero.");
  const vat = num(formData.get("vat_amount"));
  if (vat < 0 || vat > gross) flash("err", "VAT must be between 0 and the gross amount.");
  const paymentRaw = nullable(formData.get("payment_method"));
  if (paymentRaw != null && !isPaymentMethod(paymentRaw)) flash("err", "Invalid payment method.");

  const vendor_id = nullable(formData.get("vendor_id"));
  const payload: Record<string, unknown> = {
    transaction_date,
    type: typeRaw,
    allocation: allocationRaw,
    category_id: nullable(formData.get("category_id")),
    brand_id: allocationRaw === "department" ? null : nullable(formData.get("brand_id")),
    department_id: allocationRaw === "brand" ? null : nullable(formData.get("department_id")),
    // Independent of allocation: a campaign can be run by a department or for a
    // brand, so it is not cleared the way brand/department clear each other.
    campaign_id: nullable(formData.get("campaign_id")),
    vendor_id,
    vendor_name_oneoff: vendor_id ? null : nullable(formData.get("vendor_name_oneoff")),
    reference_number: nullable(formData.get("reference_number")),
    gross_amount: gross,
    vat_amount: vat,
    payment_method: paymentRaw,
    remarks: nullable(formData.get("remarks")),
    updated_at: new Date().toISOString(),
  };

  const { data: updatedData, error } = await db
    .from("expenses")
    .update(payload)
    .eq("id", id)
    .eq("workflow_stage", "encoded")
    .select(EXPENSE_SELECT)
    .maybeSingle();
  if (error) flash("err", error.message);
  const after = updatedData as ExpenseRow | null;
  if (!after) flash("err", "Edit was rejected (permission or the expense already advanced).");

  const changes = diffExpense(before, after);
  if (changes.length > 0) {
    await writeExpenseAudit(db, {
      orgId: profile.org_id,
      event: "expense_updated",
      actorId: profile.id,
      actorRole: profile.role,
      expenseId: after.id,
      expenseCode: after.expense_code,
      changes,
    });
  }

  revalidatePath("/finance/expenses/records");
  revalidatePath("/finance/expenses");
  flash(changes.length ? "ok" : "err", changes.length ? "Expense updated." : "No changes to save.");
}

// ── Cancel: void an encoded expense before submission. ceo/coo. ────────────────
// Cancelling is allowed only at 'encoded' so no in-flight action_request is left
// orphaned. A cancelled expense stays on the ledger + audit trail but never
// counts toward spend or budget utilization.
export async function cancelExpense(formData: FormData): Promise<never> {
  const profile = await requireProfile();
  if (!canManageExpense(profile.role)) flash("err", "You cannot cancel expenses.");
  const db = createServerSupabaseClient() as unknown as Shim;

  const id = str(formData.get("id"));
  if (!id) flash("err", "Missing expense.");

  const { data: currentData } = await db
    .from("expenses")
    .select("id, org_id, expense_code, status, workflow_stage")
    .eq("id", id)
    .maybeSingle();
  const before = currentData as
    | { id: string; org_id: string; expense_code: string | null; status: string; workflow_stage: string | null }
    | null;
  if (!before) flash("err", "Expense not found.");
  if ((before.workflow_stage ?? "encoded") !== "encoded") {
    flash("err", "Only an encoded expense can be cancelled. Reject it in the queue instead once submitted.");
  }

  const now = new Date().toISOString();
  const { data: updatedData, error } = await db
    .from("expenses")
    .update({ status: "cancelled", updated_at: now })
    .eq("id", id)
    .eq("workflow_stage", "encoded")
    .select("id, status")
    .maybeSingle();
  if (error) flash("err", error.message);
  if (!updatedData) flash("err", "Cancel was rejected or already applied.");

  await writeExpenseAudit(db, {
    orgId: before.org_id,
    event: "expense_cancelled",
    actorId: profile.id,
    actorRole: profile.role,
    expenseId: before.id,
    expenseCode: before.expense_code,
    changes: [{ field: "status", from: before.status, to: "cancelled" }],
  });

  revalidatePath("/finance/expenses/records");
  revalidatePath("/finance/expenses");
  flash("ok", "Expense cancelled.");
}

// ── Record payment: ready_for_payment → paid. HUMAN stamp only. ceo/coo. ────────
// MONEY GUARDRAIL: the payment was made OUTSIDE the OS (bank transfer, cheque,
// cash). This records that fact by stamping paid_at — it executes NO transfer.
export async function recordExpensePayment(formData: FormData): Promise<never> {
  const profile = await requireRole(["ceo", "coo"]);
  const db = createServerSupabaseClient() as unknown as Shim;
  const id = str(formData.get("id"));
  if (!id) flash("err", "Missing expense.");

  const { data: current } = await db
    .from("expenses")
    .select("id, org_id, expense_code, workflow_stage")
    .eq("id", id)
    .maybeSingle();
  const expense = current as
    | { id: string; org_id: string; expense_code: string | null; workflow_stage: string | null }
    | null;
  if (!expense) flash("err", "Expense not found.");
  if (expense.workflow_stage !== "ready_for_payment") {
    flash("err", "Only an approved, ready-for-payment expense can be marked paid.");
  }

  const now = new Date().toISOString();
  const { error } = await db
    .from("expenses")
    .update({ workflow_stage: "paid", status: statusForStage("paid"), paid_at: now, updated_at: now })
    .eq("id", id);
  if (error) flash("err", error.message);

  await writeExpenseAudit(db, {
    orgId: expense.org_id,
    event: "expense_paid",
    actorId: profile.id,
    actorRole: profile.role,
    expenseId: expense.id,
    expenseCode: expense.expense_code,
    changes: [{ field: "workflow_stage", from: "ready_for_payment", to: "paid" }],
    note: "Payment recorded (stamped paid — the OS moved no money).",
  });

  revalidatePath("/finance/expenses/records");
  revalidatePath("/finance/expenses");
  flash("ok", "Payment recorded (stamped paid — no money moved by the OS).");
}

// ── Archive: paid → archived. ceo/coo. ─────────────────────────────────────────
export async function archiveExpense(formData: FormData): Promise<never> {
  await requireRole(["ceo", "coo"]);
  const db = createServerSupabaseClient() as unknown as Shim;
  const id = str(formData.get("id"));
  if (!id) flash("err", "Missing expense.");

  const { data: current } = await db
    .from("expenses")
    .select("id, workflow_stage")
    .eq("id", id)
    .maybeSingle();
  const expense = current as { id: string; workflow_stage: string | null } | null;
  if (!expense) flash("err", "Expense not found.");
  if (expense.workflow_stage !== "paid") flash("err", "Only a paid expense can be archived.");

  const now = new Date().toISOString();
  const { error } = await db
    .from("expenses")
    .update({ workflow_stage: "archived", status: statusForStage("archived"), updated_at: now })
    .eq("id", id);
  if (error) flash("err", error.message);

  revalidatePath("/finance/expenses/records");
  revalidatePath("/finance/expenses");
  flash("ok", "Archived.");
}
