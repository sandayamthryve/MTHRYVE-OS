// lib/expenses/export.ts — the shared shape of an Expense export, so the CSV,
// XLSX and PDF routes all emit the SAME columns in the SAME order from the SAME
// rows. Each route only differs in how it serialises these cells.
//
// Honest nulls carry through to the file: an unknown value is an empty cell,
// never a fabricated 0 or a made-up label.

import {
  ALLOCATION_LABEL,
  PAYMENT_LABEL,
  STAGE_LABEL,
  STATUS_LABEL,
  type ExpenseView,
} from "./types";

export const EXPORT_COLUMNS = [
  "Expense Code",
  "Transaction Date",
  "Type",
  "Category Group",
  "Category",
  "Vendor",
  "Brand",
  "Department",
  "Allocation",
  "Reference #",
  "Gross",
  "VAT Input",
  "Net",
  "Payment Method",
  "Status",
  "Workflow Stage",
  "Encoded By",
  "Approved By",
  "Approved At",
  "Paid At",
  "Remarks",
] as const;

// A money value as a plain decimal string, or "" when genuinely null. Gross/VAT
// are non-null in the schema; Net can be null (empty cell, not 0).
function money(n: number | null | undefined): string {
  return n == null ? "" : (Math.round(Number(n) * 100) / 100).toFixed(2);
}

function ts(v: string | null | undefined): string {
  return v ?? "";
}

// One export row (array of string cells) aligned to EXPORT_COLUMNS. Net falls
// back to gross − vat only when the stored net is null AND both parts are known,
// otherwise stays empty — we never invent a total.
export function toExportRow(r: ExpenseView): string[] {
  const net = r.net_amount != null ? r.net_amount : r.gross_amount - r.vat_amount;
  return [
    r.expense_code ?? "",
    r.transaction_date ?? "",
    r.type,
    r.category_group ?? "",
    r.category_name ?? "",
    r.vendor_display ?? "",
    r.brand_name ?? "",
    r.department_name ?? "",
    ALLOCATION_LABEL[r.allocation] ?? r.allocation,
    r.reference_number ?? "",
    money(r.gross_amount),
    money(r.vat_amount),
    money(net),
    r.payment_method ? PAYMENT_LABEL[r.payment_method] : "",
    STATUS_LABEL[r.status] ?? r.status,
    r.workflow_stage ? STAGE_LABEL[r.workflow_stage] : "",
    r.encoder_name ?? "",
    r.approver_name ?? "",
    ts(r.approved_at),
    ts(r.paid_at),
    r.remarks ?? "",
  ];
}

export function toExportRows(rows: ExpenseView[]): string[][] {
  return rows.map(toExportRow);
}

// Column indexes that hold money, for right-alignment / numeric formatting in
// the XLSX and PDF renderers.
export const MONEY_COLUMN_INDEXES = [10, 11, 12];

export function exportFilename(ext: string): string {
  return `expenses_export.${ext}`;
}
