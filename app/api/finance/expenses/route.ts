import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { checkExpenseHygiene, runBudgetAlerts } from "@/lib/finance/expense-alerts";
import { expenseTitleLabel } from "@/lib/finance/expense-workflow";
import { writeExpenseAudit } from "@/lib/expenses/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/finance/expenses — encode one expense into the ledger, then attach
// any OR/invoice captures to it as evidence.
//
// The DB owns two fields the client must NEVER send:
//   • expense_code — assigned by the trg_assign_expense_code BEFORE INSERT
//     trigger (EXP000001-<year> …), sequenced per org+year.
//   • net_amount   — a GENERATED ALWAYS column (gross_amount - vat_amount).
// We send gross_amount + vat_amount only and read both computed fields back.
//
// RLS is the real write boundary: expenses_insert requires current_user_role() =
// 'coo' (COO writes; CEO + COO read). We mirror that here so a non-COO gets a
// clean 403 instead of an opaque RLS rejection. The row is stamped encoded_by =
// the signed-in COO, status = 'pending', workflow_stage = 'encoded'.
//
// Multipart form fields:
//   transaction_date (YYYY-MM-DD, required), type (OPEX|CAPEX, required),
//   category_id (uuid?), allocation (brand|department|business_unit|shared),
//   brand_id (uuid?), department_id (uuid?), vendor_id (uuid?),
//   vendor_name_oneoff (text? — one-time vendor fallback),
//   reference_number (text?), gross_amount (num, required), vat_amount (num),
//   payment_method (enum?), remarks (text?), files[] (OR/invoice captures).

const TYPES = new Set(["OPEX", "CAPEX"]);
const ALLOCATIONS = new Set(["brand", "business_unit", "department", "shared"]);
const PAYMENT_METHODS = new Set([
  "cash",
  "bank_transfer",
  "gcash",
  "credit_card",
  "petty_cash",
  "other",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024; // 25 MB per capture
const MAX_FILES = 8;

type Db = { from: (t: string) => any };

function num(v: FormDataEntryValue | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function uuidOrNull(v: FormDataEntryValue | null): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return UUID_RE.test(s) ? s : null;
}

function textOrNull(v: FormDataEntryValue | null): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
}

// OR/invoice captures are usually snapped photos of paper receipts; the kind
// column only permits photo/video/screenshot/link, so map by mime and default
// to 'photo' for scans/PDFs.
function kindForFile(mime: string | null): "photo" | "video" | "screenshot" {
  if (mime && mime.startsWith("video/")) return "video";
  return "photo";
}

export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  // COO writes (mirrors the expenses_insert RLS policy). CEO can read the ledger
  // but not encode.
  if (profile.role !== "coo") {
    return NextResponse.json(
      { error: "Only the COO can encode expenses." },
      { status: 403 }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const transaction_date = String(form.get("transaction_date") ?? "").trim();
  if (!DATE_RE.test(transaction_date)) {
    return NextResponse.json(
      { error: "A valid transaction date (YYYY-MM-DD) is required." },
      { status: 400 }
    );
  }

  const type = String(form.get("type") ?? "").trim().toUpperCase();
  if (!TYPES.has(type)) {
    return NextResponse.json({ error: "Type must be OPEX or CAPEX." }, { status: 400 });
  }

  const allocationRaw = String(form.get("allocation") ?? "brand").trim();
  const allocation = ALLOCATIONS.has(allocationRaw) ? allocationRaw : "brand";

  const gross_amount = num(form.get("gross_amount"));
  if (!(gross_amount > 0)) {
    return NextResponse.json(
      { error: "Gross amount must be greater than zero." },
      { status: 400 }
    );
  }
  let vat_amount = num(form.get("vat_amount"));
  if (vat_amount < 0) vat_amount = 0;
  if (vat_amount > gross_amount) {
    return NextResponse.json(
      { error: "VAT cannot exceed the gross amount." },
      { status: 400 }
    );
  }

  const payment_method_raw = textOrNull(form.get("payment_method"));
  const payment_method =
    payment_method_raw && PAYMENT_METHODS.has(payment_method_raw) ? payment_method_raw : null;

  // Allocation-scoped pickers: keep only the target that matches the allocation
  // so a stale hidden select can't smuggle a mismatched brand/department.
  const brand_id = allocation === "brand" ? uuidOrNull(form.get("brand_id")) : null;
  const department_id =
    allocation === "department" ? uuidOrNull(form.get("department_id")) : null;

  // Vendor: a picked vendor OR a one-time free-text name, never both.
  const vendor_id = uuidOrNull(form.get("vendor_id"));
  const vendor_name_oneoff = vendor_id ? null : textOrNull(form.get("vendor_name_oneoff"));

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // Insert WITHOUT expense_code / net_amount — both are DB-owned. status =
  // 'pending', workflow_stage = 'encoded', encoded_by = the signed-in COO.
  const { data: inserted, error: insErr } = await db
    .from("expenses")
    .insert({
      org_id: profile.org_id,
      transaction_date,
      type,
      category_id: uuidOrNull(form.get("category_id")),
      allocation,
      brand_id,
      department_id,
      vendor_id,
      vendor_name_oneoff,
      reference_number: textOrNull(form.get("reference_number")),
      gross_amount,
      vat_amount,
      payment_method,
      status: "pending",
      workflow_stage: "encoded",
      remarks: textOrNull(form.get("remarks")),
      encoded_by: profile.id,
    } as never)
    .select("id, expense_code, gross_amount, vat_amount, net_amount")
    .maybeSingle();

  if (insErr || !inserted) {
    return NextResponse.json(
      { error: insErr?.message || "Could not save the expense." },
      { status: 400 }
    );
  }

  const expense = inserted as {
    id: string;
    expense_code: string | null;
    gross_amount: number;
    vat_amount: number;
    net_amount: number | null;
  };

  // Attach OR/invoice captures as evidence (entity_type = 'expense'). Best-effort:
  // the expense is already saved, so a failed upload is reported, not fatal.
  const files = form
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0)
    .slice(0, MAX_FILES);

  let attached = 0;
  const attachErrors: string[] = [];

  for (const f of files) {
    if (f.size > MAX_EVIDENCE_BYTES) {
      attachErrors.push(`${f.name}: too large (max 25 MB).`);
      continue;
    }
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "receipt";
    const path = `${profile.org_id}/expense/${expense.id}/${Date.now()}_${safe}`;
    const buf = Buffer.from(await f.arrayBuffer());
    const { error: upErr } = await supabase.storage
      .from("evidence")
      .upload(path, buf, {
        contentType: f.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      attachErrors.push(`${f.name}: ${upErr.message || "upload failed"}.`);
      continue;
    }
    const { error: evErr } = await db.from("evidence_attachments").insert({
      org_id: profile.org_id,
      entity_type: "expense",
      entity_id: expense.id,
      url: path,
      kind: kindForFile(f.type || null),
      uploaded_by: profile.id,
    } as never);
    if (evErr) {
      // Roll back the orphaned object so the bucket stays clean.
      try {
        await supabase.storage.from("evidence").remove([path]);
      } catch {
        /* best-effort */
      }
      attachErrors.push(`${f.name}: ${evErr.message || "could not record evidence"}.`);
      continue;
    }
    attached += 1;
  }

  // ── Post-encode: immutable audit + hygiene/budget alerts (best-effort) ──────
  // These never block the encode (the row is already saved). Together they carry
  // the F3 audit trail and the F2 hygiene/budget monitoring through the one
  // encode path so nothing from either feature is lost.
  const label = expenseTitleLabel({ id: expense.id, expense_code: expense.expense_code });

  // Immutable "created" row on the shared action_audit trail (F3 audit view).
  await writeExpenseAudit(db, {
    orgId: profile.org_id,
    event: "expense_created",
    actorId: profile.id,
    actorRole: profile.role,
    expenseId: expense.id,
    expenseCode: expense.expense_code,
    snapshot: {
      transaction_date,
      type,
      gross_amount: expense.gross_amount,
      vat_amount: expense.vat_amount,
      net_amount: expense.net_amount,
      status: "pending",
      workflow_stage: "encoded",
      attachments: attached,
    },
  });

  // Hygiene alert to CEO + COO. A blank reference is the honest "no doc on file"
  // signal — but an attached OR/invoice IS the document, so only flag missing-doc
  // when there's neither a reference nor an attachment. A present reference still
  // runs the duplicate-reference check.
  const ref = textOrNull(form.get("reference_number"));
  if (!(ref === null && attached > 0)) {
    await checkExpenseHygiene(db, profile.org_id, {
      id: expense.id,
      expenseLabel: label,
      reference_number: ref,
      amountLabel: expense.gross_amount != null ? peso(Number(expense.gross_amount)) : null,
    });
  }

  // Refresh budget utilization so a newly-encoded expense can fire a threshold.
  await runBudgetAlerts(db, profile.org_id);

  return NextResponse.json({
    ok: true,
    id: expense.id,
    expense_code: expense.expense_code,
    gross_amount: expense.gross_amount,
    vat_amount: expense.vat_amount,
    net_amount: expense.net_amount,
    attached,
    attach_errors: attachErrors,
  });
}
