import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso, pesoOrDash, EMPTY } from "@/lib/metrics/format";
import { NewExpenseForm, type CategoryOption, type Option } from "@/components/finance/NewExpenseForm";
import { ExpenseAttachments, type ExpenseAttachment } from "@/components/finance/ExpenseAttachments";
import { loadLookups, loadExpenses, type Lookups } from "@/lib/expenses/data";
import {
  parseExpenseFilters,
  hasActiveFilters,
  filtersToQueryString,
  type ExpenseFilterParams,
} from "@/lib/expenses/filters";
import {
  ALLOCATIONS,
  ALLOCATION_LABEL,
  EXPENSE_STATUSES,
  EXPENSE_TYPES,
  PAYMENT_METHODS,
  PAYMENT_LABEL,
  STATUS_LABEL,
  canManageExpense,
  type Db,
  type ExpenseView,
} from "@/lib/expenses/types";
import {
  EXPENSE_STAGE_ORDER,
  expenseStageLabel,
  type ExpenseStage,
} from "@/lib/finance/expense-workflow";
import { submitExpense, updateExpense, cancelExpense, recordExpensePayment, archiveExpense } from "../actions";
import { RowActions as ArchiveRowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// EXPENSE RECORDS — the ledger with search / filter, filtered export (Excel /
// CSV / PDF), the encode form (with evidence upload), and the workflow controls.
// ceo/coo only. This is the reconciled surface: F3's search/filter/edit/export
// over F2's approval workflow (submit → Approval Queue → advance executor — NO
// parallel approver) with F1's evidence-capable encode form.
export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 px-2.5 py-2 text-sm text-ink placeholder:text-ink-dim";
const labelCls = "flex flex-col gap-1 text-xs text-ink-dim";

const STAGE_TONE: Record<ExpenseStage, BadgeTone> = {
  encoded: "muted",
  finance_review: "amber",
  department_approval: "amber",
  management_approval: "amber",
  ready_for_payment: "violet",
  paid: "teal",
  archived: "muted",
};
function stageTone(stage: string | null): BadgeTone {
  return stage ? STAGE_TONE[stage as ExpenseStage] ?? "muted" : "muted";
}

// --- Reusable <option> fragments (selection via parent <select defaultValue>) --
function CategoryOptions({ lk }: { lk: Lookups }) {
  return (
    <>
      {lk.categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.group_name} — {c.name}
        </option>
      ))}
    </>
  );
}
function VendorOptions({ lk }: { lk: Lookups }) {
  return (
    <>
      {lk.vendors.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </>
  );
}
function BrandOptions({ lk }: { lk: Lookups }) {
  return (
    <>
      {lk.brands.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </>
  );
}
function CampaignOptions({ lk }: { lk: Lookups }) {
  return (
    <>
      {lk.campaigns.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </>
  );
}
function DeptOptions({ lk }: { lk: Lookups }) {
  return (
    <>
      {lk.departments.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </>
  );
}

// The edit field set (no net_amount — it's a GENERATED column, derived by the DB
// from gross − VAT). Prefilled from the row.
function EditFields({ lk, row }: { lk: Lookups; row: ExpenseView }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <label className={labelCls}>
        Transaction date
        <input type="date" name="transaction_date" required defaultValue={row.transaction_date ?? ""} className={inputCls} />
      </label>
      <label className={labelCls}>
        Type
        <select name="type" required defaultValue={row.type} className={inputCls}>
          {EXPENSE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        Allocation
        <select name="allocation" defaultValue={row.allocation} className={inputCls}>
          {ALLOCATIONS.map((a) => (
            <option key={a} value={a}>
              {ALLOCATION_LABEL[a]}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        Category
        <select name="category_id" className={inputCls} defaultValue={row.category_id ?? ""}>
          <option value="">—</option>
          <CategoryOptions lk={lk} />
        </select>
      </label>
      <label className={labelCls}>
        Brand
        <select name="brand_id" className={inputCls} defaultValue={row.brand_id ?? ""}>
          <option value="">—</option>
          <BrandOptions lk={lk} />
        </select>
      </label>
      <label className={labelCls}>
        Department
        <select name="department_id" className={inputCls} defaultValue={row.department_id ?? ""}>
          <option value="">—</option>
          <DeptOptions lk={lk} />
        </select>
      </label>
      <label className={labelCls}>
        Campaign
        <select name="campaign_id" className={inputCls} defaultValue={row.campaign_id ?? ""}>
          <option value="">— none</option>
          <CampaignOptions lk={lk} />
        </select>
      </label>
      <label className={labelCls}>
        Vendor
        <select name="vendor_id" className={inputCls} defaultValue={row.vendor_id ?? ""}>
          <option value="">— (or one-off below)</option>
          <VendorOptions lk={lk} />
        </select>
      </label>
      <label className={labelCls}>
        One-off vendor
        <input name="vendor_name_oneoff" defaultValue={row.vendor_name_oneoff ?? ""} className={inputCls} />
      </label>
      <label className={labelCls}>
        Reference #
        <input name="reference_number" defaultValue={row.reference_number ?? ""} className={inputCls} />
      </label>
      <label className={labelCls}>
        Gross amount
        <input name="gross_amount" required inputMode="decimal" defaultValue={String(row.gross_amount)} className={inputCls} />
      </label>
      <label className={labelCls}>
        VAT input
        <input name="vat_amount" inputMode="decimal" defaultValue={String(row.vat_amount)} className={inputCls} />
      </label>
      <label className={labelCls}>
        Payment method
        <select name="payment_method" className={inputCls} defaultValue={row.payment_method ?? ""}>
          <option value="">—</option>
          {PAYMENT_METHODS.map((p) => (
            <option key={p} value={p}>
              {PAYMENT_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <label className={`${labelCls} col-span-2 md:col-span-3`}>
        Remarks
        <input name="remarks" defaultValue={row.remarks ?? ""} className={inputCls} />
      </label>
    </div>
  );
}

// Stage-appropriate workflow controls for a row (plain server forms → flash).
function RowActions({ lk, row }: { lk: Lookups; row: ExpenseView }) {
  const stage = row.workflow_stage ?? "encoded";
  const btn = "rounded-md px-2.5 py-1 text-xs font-semibold";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stage === "encoded" && (
        <>
          <form action={submitExpense}>
            <input type="hidden" name="id" value={row.id} />
            <button className={`${btn} border border-teal-500/40 bg-teal-500/10 text-teal-200 hover:bg-teal-500/20`}>
              Submit for approval
            </button>
          </form>
          <details className="inline-block">
            <summary className={`${btn} cursor-pointer border border-charcoal-700 text-ink-muted hover:text-ink`}>
              Edit
            </summary>
            <div className="absolute z-10 mt-1 w-[min(92vw,720px)] rounded-xl border border-charcoal-700 bg-charcoal-900 p-4 shadow-elevate">
              <form action={updateExpense}>
                <input type="hidden" name="id" value={row.id} />
                <EditFields lk={lk} row={row} />
                <div className="mt-3">
                  <button className={`${btn} bg-teal-500 text-charcoal-950 hover:bg-teal-400`}>Save changes</button>
                </div>
              </form>
            </div>
          </details>
          <form action={cancelExpense}>
            <input type="hidden" name="id" value={row.id} />
            <button className={`${btn} border border-charcoal-700 text-ink-muted hover:text-red-300`}>Cancel</button>
          </form>
        </>
      )}
      {["finance_review", "department_approval", "management_approval"].includes(stage) && (
        <Link href="/approvals" className={`${btn} border border-charcoal-700 text-teal-300 hover:bg-charcoal-800`}>
          In approval queue →
        </Link>
      )}
      {stage === "ready_for_payment" && (
        <form action={recordExpensePayment}>
          <input type="hidden" name="id" value={row.id} />
          <button className={`${btn} border border-teal-500/40 bg-teal-500/10 text-teal-200 hover:bg-teal-500/20`}>
            Record payment made
          </button>
        </form>
      )}
      {stage === "paid" && (
        <form action={archiveExpense}>
          <input type="hidden" name="id" value={row.id} />
          <button className={`${btn} border border-charcoal-700 text-ink-muted hover:text-ink`}>Archive</button>
        </form>
      )}
      {stage === "archived" && <span className="text-xs text-ink-dim">—</span>}
    </div>
  );
}

export default async function ExpenseRecordsPage({
  searchParams,
}: {
  searchParams?: ExpenseFilterParams & { flash?: string; msg?: string; archived?: string };
}) {
  const profile = await requireModule("/finance/expenses/records");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;
  const isCoo = profile.role === "coo";

  const archived = searchParams?.archived === "1";
  const filters = parseExpenseFilters(searchParams);
  const lookups = await loadLookups(db, profile.org_id);
  const rows = await loadExpenses(db, lookups, filters, 500, { archived });

  // Attachments for everything on screen, in one query rather than per row —
  // 500 rows would otherwise be 500 round trips. Grouped by expense so the
  // count in the cell is right before anyone opens it. A failed read costs the
  // Docs column its contents, not the ledger.
  const attachmentsByExpense = new Map<string, ExpenseAttachment[]>();
  if (rows.length) {
    try {
      const { data } = await db
        .from("expense_attachments")
        .select("id, expense_id, file_name, kind, byte_size, created_at")
        .eq("org_id", profile.org_id)
        .in("expense_id", rows.map((r) => r.id))
        .order("created_at", { ascending: false });

      for (const a of (data ?? []) as (ExpenseAttachment & { expense_id: string })[]) {
        const list = attachmentsByExpense.get(a.expense_id) ?? [];
        list.push(a);
        attachmentsByExpense.set(a.expense_id, list);
      }
    } catch {
      // The table may not exist yet on an un-migrated database. The Docs column
      // shows empty rather than taking the page down with it.
    }
  }

  const qs = filtersToQueryString(filters);
  const exportHref = (fmt: string) => `/api/finance/expenses/export/${fmt}${qs ? `?${qs}` : ""}`;
  const flash = searchParams?.flash === "ok" || searchParams?.flash === "err" ? searchParams : null;

  // Stage roll-up over the filtered set (cancelled excluded from money sums).
  const live = rows.filter((r) => r.status !== "cancelled");
  const sum = (rs: ExpenseView[]) => rs.reduce((a, e) => a + Number(e.gross_amount ?? 0), 0);
  const inReview = live.filter((e) =>
    ["finance_review", "department_approval", "management_approval"].includes(e.workflow_stage ?? "")
  );
  const readyToPay = live.filter((e) => e.workflow_stage === "ready_for_payment");
  const paid = live.filter((e) => e.workflow_stage === "paid" || e.workflow_stage === "archived");

  // Category options for the encode form (F1 NewExpenseForm) — its shape matches
  // the lookup rows; the export/filter data layer supplies them.
  const categoryOptions = lookups.categories as unknown as CategoryOption[];
  const vendorOptions = lookups.vendors as unknown as Option[];
  const brandOptions = lookups.brands as unknown as Option[];
  const deptOptions = lookups.departments as unknown as Option[];
  const campaignOptions = lookups.campaigns as unknown as Option[];

  return (
    <AppShell breadcrumb={["Finance", "Expenses", "Records"]} profile={profile}>
      <PageHeader
        title="Expense Records"
        subtitle="Search, filter, export and run the approval workflow over the ledger."
        action={
          <div className="flex items-center gap-2">
            <Link href="/finance/expenses" className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Dashboard
            </Link>
            <Link href="/finance/expenses/audit" className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink">
              Audit
            </Link>
          </div>
        }
      />

      {/* Money guardrail. */}
      <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200/90">
        <span className="font-semibold text-amber-200">The OS never moves money.</span> Approvals are filed to the{" "}
        <Link href="/approvals" className="underline hover:text-ink">
          Approval Queue
        </Link>{" "}
        (one human per gate — finance → department → management). Marking an expense{" "}
        <span className="font-mono">paid</span> only stamps <span className="font-mono">paid_at</span>; it executes no transfer.
      </div>

      {flash && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            flash.flash === "ok"
              ? "border-teal-500/40 bg-teal-500/10 text-teal-200"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
        >
          {flash.msg ?? (flash.flash === "ok" ? "Done." : "Something went wrong.")}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="In review" value={String(inReview.length)} hint={peso(sum(inReview))} />
        <StatTile label="Ready for payment" value={String(readyToPay.length)} hint={peso(sum(readyToPay))} valueClassName="text-violet-300" />
        <StatTile label="Paid / archived" value={String(paid.length)} hint={peso(sum(paid))} valueClassName="text-teal-300" />
        <StatTile label="Rows shown" value={String(rows.length)} hint={`${pesoOrDash(sum(live))} live`} />
      </div>

      {/* Encode — COO only (expenses INSERT is coo-only under RLS). F1 form: it
          uploads OR/invoice evidence and the route fires hygiene + budget alerts. */}
      <SectionCard title="Encode a new expense" className="mb-6">
        {isCoo ? (
          <NewExpenseForm
            categories={categoryOptions}
            vendors={vendorOptions}
            brands={brandOptions}
            departments={deptOptions}
            campaigns={campaignOptions}
          />
        ) : (
          <p className="text-sm text-ink-muted">
            Encoding is COO-only. As CEO you can review, approve (in the{" "}
            <Link href="/approvals" className="underline hover:text-ink">
              Approval Queue
            </Link>
            ) and record payments below.
          </p>
        )}
      </SectionCard>

      {/* Search / filter — plain GET form; the export links carry the same query. */}
      <SectionCard title="Search & Filter" className="mb-4">
        <form method="get" className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <label className={labelCls}>
            From
            <input type="date" name="start" defaultValue={filters.start ?? ""} className={inputCls} />
          </label>
          <label className={labelCls}>
            To
            <input type="date" name="end" defaultValue={filters.end ?? ""} className={inputCls} />
          </label>
          <label className={`${labelCls} col-span-2`}>
            Search (code / reference / vendor)
            <input name="q" defaultValue={filters.q ?? ""} placeholder="EXP000123-2026…" className={inputCls} />
          </label>
          <label className={labelCls}>
            Type
            <select name="type" defaultValue={filters.type ?? ""} className={inputCls}>
              <option value="">All</option>
              {EXPENSE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Status
            <select name="status" defaultValue={filters.status ?? ""} className={inputCls}>
              <option value="">All</option>
              {EXPENSE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Payment
            <select name="payment_method" defaultValue={filters.paymentMethod ?? ""} className={inputCls}>
              <option value="">All</option>
              {PAYMENT_METHODS.map((p) => (
                <option key={p} value={p}>
                  {PAYMENT_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Allocation
            <select name="allocation" defaultValue={filters.allocation ?? ""} className={inputCls}>
              <option value="">All</option>
              {ALLOCATIONS.map((a) => (
                <option key={a} value={a}>
                  {ALLOCATION_LABEL[a]}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Vendor
            <select name="vendor_id" defaultValue={filters.vendorId ?? ""} className={inputCls}>
              <option value="">All</option>
              <VendorOptions lk={lookups} />
            </select>
          </label>
          <label className={labelCls}>
            Brand
            <select name="brand_id" defaultValue={filters.brandId ?? ""} className={inputCls}>
              <option value="">All</option>
              <BrandOptions lk={lookups} />
            </select>
          </label>
          <label className={labelCls}>
            Department
            <select name="department_id" defaultValue={filters.departmentId ?? ""} className={inputCls}>
              <option value="">All</option>
              <DeptOptions lk={lookups} />
            </select>
          </label>
          <label className={labelCls}>
            Category
            <select name="category_id" defaultValue={filters.categoryId ?? ""} className={inputCls}>
              <option value="">All</option>
              <CategoryOptions lk={lookups} />
            </select>
          </label>
          <label className={labelCls}>
            Encoder
            <select name="encoder_id" defaultValue={filters.encoderId ?? ""} className={inputCls}>
              <option value="">All</option>
              {lookups.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <div className="col-span-2 flex flex-wrap items-end gap-2 md:col-span-4 lg:col-span-6">
            <button type="submit" className="rounded-lg bg-teal-500/20 px-4 py-2 text-sm font-medium text-teal-200 hover:bg-teal-500/30">
              Apply filters
            </button>
            {hasActiveFilters(filters) && (
              <Link href="/finance/expenses/records" className="rounded-lg border border-charcoal-700 px-4 py-2 text-sm text-ink-muted hover:text-ink">
                Clear
              </Link>
            )}
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <span className="text-xs text-ink-dim">Export:</span>
              <a href={exportHref("xlsx")} className="rounded-md border border-charcoal-700 px-3 py-1.5 text-xs text-ink-muted hover:text-ink">
                Excel
              </a>
              <a href={exportHref("csv")} className="rounded-md border border-charcoal-700 px-3 py-1.5 text-xs text-ink-muted hover:text-ink">
                CSV
              </a>
              <a href={exportHref("pdf")} className="rounded-md border border-charcoal-700 px-3 py-1.5 text-xs text-ink-muted hover:text-ink">
                PDF
              </a>
            </div>
          </div>
        </form>
      </SectionCard>

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{archived ? "Archived expenses" : "Ledger"}</h2>
        <ArchivedToggle
          basePath="/finance/expenses/records"
          archived={archived}
          params={Object.fromEntries(new URLSearchParams(qs))}
        />
      </div>

      <TableShell
        columns={["Code", "Date", "Type", "Vendor", "Brand / Dept", "Category", "Gross", "VAT", "Stage", "Encoder", "Docs", "Actions", "Manage"]}
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={13} className="p-6 text-center text-sm text-ink-muted">
              No expenses match these filters.
            </td>
          </tr>
        ) : (
          rows.map((r) => (
            <tr key={r.id} className={rowClass}>
              <td className="p-3 font-mono text-xs text-ink">{r.expense_code ?? EMPTY}</td>
              <td className="p-3 text-ink-muted">{r.transaction_date}</td>
              <td className="p-3">
                <Badge tone={r.type === "CAPEX" ? "violet" : "muted"}>{r.type}</Badge>
              </td>
              <td className="p-3 text-ink">{r.vendor_display ?? EMPTY}</td>
              <td className="p-3 text-ink-muted">
                {r.brand_name ?? r.department_name ?? <span className="text-ink-dim">{ALLOCATION_LABEL[r.allocation]}</span>}
              </td>
              <td className="p-3 text-ink-muted">{r.category_name ?? EMPTY}</td>
              <td className="p-3 font-medium text-ink">{pesoOrDash(r.gross_amount)}</td>
              <td className="p-3 text-ink-muted">{pesoOrDash(r.vat_amount)}</td>
              <td className="p-3">
                <div className="flex flex-col gap-1">
                  <Badge tone={stageTone(r.workflow_stage)}>{expenseStageLabel(r.workflow_stage)}</Badge>
                  {r.status === "cancelled" && <Badge tone="red">Cancelled</Badge>}
                </div>
              </td>
              <td className="p-3 text-ink-muted">{r.encoder_name ?? EMPTY}</td>
              <td className="p-3">
                {/* Supporting documents. Uploading is gated on the same role
                    that may encode — attaching the receipt is part of encoding,
                    and the insert policy re-checks it either way. */}
                <ExpenseAttachments
                  expenseId={r.id}
                  attachments={attachmentsByExpense.get(r.id) ?? []}
                  canUpload={canManageExpense(profile.role)}
                />
              </td>
              <td className="p-3">
                <RowActions lk={lookups} row={r} />
              </td>
              <td className="p-3">
                <ArchiveRowActions {...rowActionProps("expenses", r as unknown as Record<string, unknown>, profile)} />
              </td>
            </tr>
          ))
        )}
      </TableShell>

      {/* Lifecycle legend. */}
      <div className="mt-6 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
        {EXPENSE_STAGE_ORDER.map((s, i) => (
          <span key={s} className="flex items-center gap-1.5">
            <Badge tone={stageTone(s)}>{expenseStageLabel(s)}</Badge>
            {i < EXPENSE_STAGE_ORDER.length - 1 && <span className="text-ink-dim">→</span>}
          </span>
        ))}
      </div>
      <p className="mt-3 text-xs text-ink-dim">
        Showing up to 500 rows. Edit and cancel are available only before submission; once submitted, a rejected gate
        in the queue kicks the expense back to encoded for correction. Every step writes an immutable{" "}
        <Link href="/finance/expenses/audit" className="text-teal-300 hover:underline">
          audit row
        </Link>
        .
      </p>
    </AppShell>
  );
}
