import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { WarehouseTabs } from "@/components/warehouse/WarehouseTabs";
import { QuerySelect, QuerySearch } from "@/components/warehouse/QueryControls";
import { requireProfile, requireRole, requireDepartment, isWarehouseWriter } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { pesoOrDash } from "@/lib/metrics/format";
import { manilaStamp } from "@/lib/metrics/windows";
import { revalidatePath } from "next/cache";
import { ProductsCsvButton } from "./ProductsCsvButton";
import { DeleteProductButton } from "./DeleteProductButton";
import { AddProductForm, type AddProductState } from "./AddProductForm";
import {
  PRODUCT_COLUMNS,
  type ProductMaster,
  type ProductHistoryRow,
  type Shim,
} from "@/lib/warehouse/inventory";
import { recountStock } from "@/lib/warehouse/mutations";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { BulkSelect } from "@/components/warehouse/BulkSelect";
import { planBulkEdit } from "@/lib/warehouse/bulk-edit";
import { rowActionProps } from "@/lib/archive/config";

// Warehouse — Product Master (CRUD + audit). The catalogue every Warehouse
// surface reads from. Editable per SKU: name, SKU, variant, barcode, warehouse
// location, brand, category, cost, selling price, status — and every EDIT is
// recorded to product_history by the DB trigger (user / date / time / changed
// fields), surfaced in the History Logs panel below. Writing the catalogue is
// Warehouse-team + leadership (RLS on products); deleting is leadership-only.

export const dynamic = "force-dynamic";

type Brand = { id: string; name: string };

// products isn't in the generated Supabase types, so writes go through this shim.
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown> | Record<string, unknown>[]) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => { eq: (c: string, val: string) => Promise<unknown> };
      // Bulk edit updates many ids in one statement, still scoped by org_id.
      in: (c: string, vals: string[]) => { eq: (c: string, val: string) => Promise<unknown> };
    };
    delete: () => { eq: (c: string, val: string) => { eq: (c: string, val: string) => Promise<unknown> } };
  };
};

const STATUSES: { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "discontinued", label: "Discontinued" },
  { value: "archived", label: "Archived" },
];
const STATUS_SET = new Set(STATUSES.map((s) => s.value));

function isDate(s?: string | null): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function intOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? n : null;
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function flag(v: FormDataEntryValue | string | null): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "x" || s === "on";
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// --- Server actions --------------------------------------------------------

// Build the writable column set from a form. Shared by create + update so the
// two never drift. sku is required by the caller before this runs.
function productPatchFromForm(formData: FormData): Record<string, unknown> {
  const statusRaw = String(formData.get("status") ?? "active");
  const stocked = String(formData.get("stocked_at") ?? "");
  const expiry = String(formData.get("expiry_date") ?? "");
  const target = intOrNull(formData.get("target_cover_days"));
  return {
    brand_id: String(formData.get("brand_id") ?? "") || null,
    sku: String(formData.get("sku") ?? "").trim(),
    product_name: String(formData.get("product_name") ?? "").trim() || null,
    variant: String(formData.get("variant") ?? "").trim() || null,
    barcode: String(formData.get("barcode") ?? "").trim() || null,
    warehouse_location: String(formData.get("warehouse_location") ?? "").trim() || null,
    category: String(formData.get("category") ?? "").trim() || null,
    cost: numOrNull(formData.get("cost")),
    selling_price: numOrNull(formData.get("selling_price")),
    is_fragile: flag(formData.get("is_fragile")),
    is_perishable: flag(formData.get("is_perishable")),
    is_high_value: flag(formData.get("is_high_value")),
    unit_value: numOrNull(formData.get("unit_value")),
    stocked_at: isDate(stocked) ? stocked : null,
    expiry_date: isDate(expiry) ? expiry : null,
    reorder_point: intOrNull(formData.get("reorder_point")),
    target_cover_days: target != null && target > 0 ? target : 30,
    status: STATUS_SET.has(statusRaw) ? statusRaw : "active",
    notes: String(formData.get("notes") ?? "").trim() || null,
  };
}

// Add a product — Warehouse team + leadership. The ONLY single-row INSERT path.
// Before inserting it blocks a second product with the same SKU under the same
// brand in the org — that is how a duplicate SKU is born and must never happen
// here. The DB unique index on (org_id, brand_id, sku) is the last-line backstop;
// this gives a clear inline message instead of an opaque constraint error.
// Editing goes through updateProduct (UPDATE by id) and never reaches here. An
// opening stock count is optional and, when given, lands in stock_levels (the
// on-hand home) via a manual_correction so the ledger stays consistent from the
// first count. Shaped for useFormState so the block/error surfaces inline.
async function createProduct(
  _prev: AddProductState,
  formData: FormData
): Promise<AddProductState> {
  "use server";
  const profile = await requireProfile();
  if (!isWarehouseWriter(profile)) return { error: "Not authorised — Warehouse team or leadership only." };
  const patch = productPatchFromForm(formData);
  if (!patch.sku) return { error: "SKU is required." };
  const supabase = createServerSupabaseClient();

  // Duplicate guard: same SKU under the same brand in this org. Mirrors the
  // (org_id, brand_id, sku) unique index. A blank brand still blocks a repeat SKU
  // here (friendlier than the index, which treats a null brand as distinct).
  const sku = patch.sku as string;
  const brandId = (patch.brand_id as string | null) ?? null;
  const { data: existing } = await supabase
    .from("products")
    .select("id, sku, brand_id")
    .eq("org_id", profile.org_id);
  const dup = ((existing ?? []) as { sku: string; brand_id: string | null }[]).find(
    (r) => (r.sku ?? "").trim() === sku && (r.brand_id ?? null) === brandId
  );
  if (dup) {
    return {
      error: `A product with SKU "${sku}"${brandId ? " for this brand" : ""} already exists — open it to edit instead of adding a new one.`,
    };
  }

  const { error } = (await (supabase as unknown as DbShim).from("products").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    ...patch,
  })) as { error: { code?: string; message?: string } | null };
  if (error) {
    // Backstop: the unique index rejected a race that slipped past the check.
    if (isUniqueViolation(error)) {
      return {
        error: `A product with SKU "${sku}"${brandId ? " for this brand" : ""} already exists — open it to edit instead of adding a new one.`,
      };
    }
    return { error: "Could not add the product. Please try again." };
  }

  const stock = intOrNull(formData.get("stock"));
  if (stock != null && stock >= 0) {
    // Resolve the just-created product id to attach the opening count.
    const { data: created } = await supabase
      .from("products")
      .select("id, brand_id")
      .eq("org_id", profile.org_id)
      .eq("sku", patch.sku as string)
      .limit(1);
    const row = (created as unknown as { id: string; brand_id: string | null }[] | null)?.[0];
    if (row) {
      await recountStock(supabase as unknown as Shim, {
        orgId: profile.org_id,
        productId: row.id,
        brandId: row.brand_id,
        countedStock: stock,
        note: "Opening count",
      });
    }
  }

  revalidatePath("/warehouse/products");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/overview");
  revalidatePath("/warehouse/intelligence");
  return null;
}

// Edit a product — Warehouse team + leadership. The DB trigger writes the diff
// to product_history automatically (who / when / what changed).
async function updateProduct(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  if (!isWarehouseWriter(profile)) return;
  // Save ALWAYS updates the opened product by its id — it never inserts. With no
  // id we bail rather than fall through to any create path, so an absent/empty id
  // can never silently mint a duplicate.
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return;
  const patch = productPatchFromForm(formData);
  if (!patch.sku) return;
  const supabase = createServerSupabaseClient();
  // Editing to a SKU already used by another product under the same brand is
  // rejected by the (org_id, brand_id, sku) unique index. supabase-js returns the
  // error rather than throwing, so this can never surface a stack trace or spawn a
  // duplicate — the row simply keeps its prior value.
  await (supabase as unknown as DbShim)
    .from("products")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", profile.org_id);
  revalidatePath("/warehouse/products");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/overview");
  revalidatePath("/warehouse/intelligence");
}

// Bulk edit — set ONE field across the selected products in a single statement.
//
// Deliberately narrow. Only the four grouping fields are offered: brand,
// category, warehouse location and status. Name, SKU, variant and barcode
// identify a single product, so a bulk write of them would either fail the
// (org_id, brand_id, sku) unique index or quietly collapse several products
// onto one identity; cost and price are per-product facts that almost nobody
// means to flatten. Excluding them is the feature, not a gap.
//
// The product_history trigger audits each affected row on its own, so a bulk
// change lands in the history log as one entry per product with the same user
// and timestamp — which is what "record user, date, time and exactly what
// changed" has to mean when the change covers many rows at once.
// The guard itself lives in lib/warehouse/bulk-edit.ts, where it is a pure
// function with a test — the cases that matter are the ones this UI cannot
// produce.
async function bulkEditProducts(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  if (!isWarehouseWriter(profile)) return;

  const plan = planBulkEdit({
    ids: formData.getAll("ids").map((v) => String(v)),
    field: String(formData.get("field") ?? ""),
    value: String(formData.get("value") ?? ""),
    // STATUSES above stays the single definition of the vocabulary.
    knownStatuses: STATUS_SET,
  });
  if (!plan) return;
  const { ids, field, value } = plan;

  const supabase = createServerSupabaseClient();
  // org_id is matched as well as the ids, so a forged id from another org
  // updates nothing rather than reaching across the tenant boundary. RLS is the
  // real guard; this makes the query say so too.
  await (supabase as unknown as DbShim)
    .from("products")
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("org_id", profile.org_id);

  revalidatePath("/warehouse/products");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/overview");
  revalidatePath("/warehouse/intelligence");
}

// Archive a product — Warehouse team + leadership. A status change, so it too is
// audited by the product_history trigger.
async function archiveProduct(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  if (!isWarehouseWriter(profile)) return;
  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("next_status") ?? "archived");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("products")
    .update({ status: STATUS_SET.has(next) ? next : "archived", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", profile.org_id);
  revalidatePath("/warehouse/products");
  revalidatePath("/warehouse/overview");
}

// Deleting a product is leadership-only.
async function deleteProduct(formData: FormData) {
  "use server";
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("products").delete().eq("id", id).eq("org_id", profile.org_id);
  revalidatePath("/warehouse/products");
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/overview");
  revalidatePath("/warehouse/intelligence");
}

// A Postgres unique-constraint violation (code 23505) — the DB backstop firing.
// Recognised so the UI can show a friendly "already exists" instead of the raw
// constraint error, never a stack trace.
function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  const m = (error.message ?? "").toLowerCase();
  return m.includes("duplicate key") || m.includes("unique constraint");
}

// --- Page ------------------------------------------------------------------

function statusTone(s: string): "teal" | "amber" | "muted" | "red" {
  if (s === "active") return "teal";
  if (s === "paused") return "amber";
  if (s === "archived") return "muted";
  return "red";
}

export default async function ProductMasterPage({
  searchParams,
}: {
  searchParams: { brand?: string; status?: string; category?: string; q?: string; archived?: string };
}) {
  // Warehouse (Commerce operating surface) — department-scoped to E-Commerce Ops
  // + Warehouse & Fulfillment; leadership bypasses. Write/delete stay gated by
  // isWarehouseWriter / requireRole below; RLS on products is the real guard.
  const profile = await requireModule("/warehouse/products");
  const canWrite = isWarehouseWriter(profile);
  const canDelete =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const archived = searchParams?.archived === "1";
  const supabase = createServerSupabaseClient();

  const productQ = supabase
    .from("products")
    .select(`${PRODUCT_COLUMNS}, archived_at`)
    .eq("org_id", profile.org_id)
    .order("product_name");
  const [brandRes, productRes, historyRes] = await Promise.all([
    supabase.from("brands").select("id, name").eq("org_id", profile.org_id).order("name"),
    archived ? productQ.not("archived_at", "is", null) : productQ.is("archived_at", null),
    supabase
      .from("product_history")
      .select("id, product_id, user_id, changed_at, changes")
      .eq("org_id", profile.org_id)
      .order("changed_at", { ascending: false })
      .limit(60),
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const products = (productRes.data ?? []) as unknown as ProductMaster[];
  const history = (historyRes.data ?? []) as unknown as ProductHistoryRow[];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const productName = (id: string) => {
    const p = products.find((x) => x.id === id);
    return p ? p.product_name?.trim() || p.sku : "—";
  };

  const { data: userRows } = await supabase.from("users").select("id, full_name");
  const userName = new Map(
    ((userRows ?? []) as unknown as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name])
  );

  // Filters (instant refresh via client controls).
  const brandFilter =
    searchParams.brand && brands.some((b) => b.id === searchParams.brand) ? searchParams.brand : "all";
  const statusFilter = searchParams.status && STATUS_SET.has(searchParams.status) ? searchParams.status : "all";
  const categories = Array.from(
    new Set(products.map((p) => (p.category ?? "").trim()).filter(Boolean))
  ).sort();
  const categoryFilter =
    searchParams.category && categories.includes(searchParams.category) ? searchParams.category : "all";
  const q = (searchParams.q ?? "").trim().toLowerCase();

  const shown = products.filter((p) => {
    if (brandFilter !== "all" && p.brand_id !== brandFilter) return false;
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (categoryFilter !== "all" && (p.category ?? "").trim() !== categoryFilter) return false;
    if (q) {
      const hay = [p.sku, p.product_name ?? "", p.variant ?? "", p.barcode ?? "", p.warehouse_location ?? ""]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const totalProducts = products.length;
  const activeProducts = products.filter((p) => p.status === "active").length;
  const archivedProducts = products.filter((p) => p.status === "archived").length;
  const withPricing = products.filter((p) => p.cost != null || p.selling_price != null).length;

  const exportRows = products.map((p) => ({
    brand: brandName(p.brand_id) === "—" ? "" : brandName(p.brand_id),
    sku: p.sku,
    product_name: p.product_name ?? "",
    variant: p.variant ?? "",
    barcode: p.barcode ?? "",
    warehouse_location: p.warehouse_location ?? "",
    category: p.category ?? "",
    cost: p.cost != null ? String(p.cost) : "",
    selling_price: p.selling_price != null ? String(p.selling_price) : "",
    reorder_point: p.reorder_point != null ? String(p.reorder_point) : "",
    status: p.status,
    notes: p.notes ?? "",
  }));

  const editCls = "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink";

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse", "Product Master"]} profile={profile}>
      <PageHeader
        title="Warehouse — Product Master"
        subtitle="The SKU catalogue — variant, barcode, location, cost, price, reorder rules and status. Every edit is audited to product history."
        action={<ProductsCsvButton rows={exportRows} filename="products.csv" />}
      />
      <WarehouseTabs active="products" />

      {/* Summary */}
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Products" value={totalProducts} />
        <StatTile label="Active" value={activeProducts} hint={`of ${totalProducts}`} />
        <StatTile label="Archived" value={archivedProducts} />
        <StatTile label="With cost / price" value={withPricing} />
      </div>

      {/* Filters + search */}
      <div className="mb-8 flex flex-wrap items-end gap-2">
        <QuerySelect
          name="brand"
          label="Brand"
          value={brandFilter}
          options={[{ value: "all", label: "All brands" }, ...brands.map((b) => ({ value: b.id, label: b.name }))]}
        />
        <QuerySelect
          name="status"
          label="Status"
          value={statusFilter}
          options={[{ value: "all", label: "All statuses" }, ...STATUSES]}
        />
        <QuerySelect
          name="category"
          label="Category"
          value={categoryFilter}
          options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c, label: c }))]}
        />
        <QuerySearch
          name="q"
          label="Search"
          value={searchParams.q ?? ""}
          placeholder="SKU, name, variant, barcode, location…"
          className="min-w-[240px]"
        />
      </div>

      {/* Add a product — writer only */}
      {canWrite && (
        <SectionCard title="Add a product" className="mb-8">
          <AddProductForm action={createProduct} brands={brands} statuses={STATUSES} />
        </SectionCard>
      )}

      {/* Bulk upload — writer only. One import engine lives at /imports: it accepts
          CSV, XLSX and XLS, detects the header row, resolves the brand to a client
          (never a null brand), previews before committing, and audits every run. */}
      {canWrite && (
        <SectionCard title="Bulk upload (CSV / Excel)" className="mb-8">
          <p className="mb-3 text-xs text-ink-muted">
            Product bulk import moved to the one Bulk Import tool — it accepts CSV, XLSX and XLS,
            finds the header row even when it isn&apos;t row 1, resolves the brand column to an
            existing client, previews what lands where, and blocks duplicates so re-uploading the
            same file never doubles your catalogue.
          </p>
          <a
            href="/imports?entity=products"
            className="inline-block rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
          >
            Open Bulk Import →
          </a>
        </SectionCard>
      )}

      {/* Product table */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">
          Products{" "}
          <span className="font-mono text-[11px] text-ink-dim">
            {shown.length}/{totalProducts}
          </span>
        </h2>
        <ArchivedToggle
          basePath="/warehouse/products"
          archived={archived}
          params={{
            ...(searchParams.brand ? { brand: searchParams.brand } : {}),
            ...(searchParams.status ? { status: searchParams.status } : {}),
            ...(searchParams.category ? { category: searchParams.category } : {}),
            ...(searchParams.q ? { q: searchParams.q } : {}),
          }}
        />
      </div>

      {/* Bulk edit — writer only. The form lives here and the row checkboxes
          bind to it by id, so it never nests inside the per-row edit forms. */}
      {canWrite && (
        <form id="pm-bulk" action={bulkEditProducts} className="mb-3">
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-charcoal-700 bg-charcoal-900 p-3">
            <BulkSelect formId="pm-bulk" />
            <label className="text-[11px] text-ink-muted">
              Set field
              <select name="field" defaultValue="status" className={`${editCls} mt-1 block`}>
                <option value="status">Status</option>
                <option value="category">Category</option>
                <option value="warehouse_location">Warehouse location</option>
                <option value="brand_id">Brand</option>
              </select>
            </label>
            <label className="text-[11px] text-ink-muted">
              To value
              <input
                name="value"
                placeholder="active / a category / a bin / a brand id"
                className={`${editCls} mt-1 block min-w-[220px]`}
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-teal-400 px-3 py-1.5 text-xs font-bold text-[#04120c] transition hover:brightness-110"
            >
              Apply to selected
            </button>
            <p className="w-full text-[11px] text-ink-dim">
              Brand, category, location and status only — SKU, name, variant, barcode, cost and
              price identify one product each and are edited per row. Every product changed is
              written to the history log below.
            </p>
          </div>
        </form>
      )}

      <TableShell
        columns={[
          ...(canWrite ? [""] : []),
          "Brand",
          "SKU / variant / barcode",
          "Product / category",
          "Location",
          "Cost / price",
          "Reorder",
          "Status",
          ...(canWrite ? [""] : []),
          "Manage",
        ]}
      >
        {shown.length === 0 && (
          <tr>
            <td colSpan={canWrite ? 10 : 8} className="p-4 text-ink-muted">
              No products match these filters.
            </td>
          </tr>
        )}
        {shown.map((p) => {
          const fid = `pm-${p.id}`;
          if (!canWrite) {
            return (
              <tr key={p.id} className={rowClass}>
                <td className="p-3 text-ink">{brandName(p.brand_id)}</td>
                <td className="p-3 font-mono text-xs text-ink">
                  {p.sku}
                  {p.variant ? <span className="text-ink-dim"> · {p.variant}</span> : ""}
                  {p.barcode ? <div className="text-[10px] text-ink-dim">{p.barcode}</div> : null}
                </td>
                <td className="p-3 text-ink">
                  {p.product_name ?? "—"}
                  {p.category ? <div className="text-[11px] text-ink-dim">{p.category}</div> : null}
                </td>
                <td className="p-3 text-ink-muted">{p.warehouse_location ?? "—"}</td>
                <td className="p-3 font-mono text-xs text-ink">
                  {pesoOrDash(p.cost)} / {pesoOrDash(p.selling_price)}
                </td>
                <td className="p-3 font-mono text-ink">{p.reorder_point ?? "—"}</td>
                <td className="p-3">
                  <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                </td>
                <td className="p-3 align-top">
                  <RowActions {...rowActionProps("products", p as unknown as Record<string, unknown>, profile)} />
                </td>
              </tr>
            );
          }
          return (
            <tr key={p.id} className={rowClass}>
              <td className="p-3 align-top">
                {/* Bound to the bulk form by id, never nested in the row form. */}
                <input
                  form="pm-bulk"
                  type="checkbox"
                  name="ids"
                  value={p.id}
                  aria-label={`Select ${p.sku}`}
                  className="h-3.5 w-3.5 accent-teal-400"
                />
              </td>
              <td className="p-3 align-top">
                <form id={fid} action={updateProduct} className="contents">
                  <input type="hidden" name="id" value={p.id} />
                </form>
                <select form={fid} name="brand_id" defaultValue={p.brand_id ?? ""} className={editCls}>
                  <option value="">—</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="p-3 align-top">
                <input form={fid} name="sku" defaultValue={p.sku} className={`${editCls} font-mono`} />
                <input
                  form={fid}
                  name="variant"
                  defaultValue={p.variant ?? ""}
                  placeholder="variant"
                  className={`${editCls} mt-1`}
                />
                <input
                  form={fid}
                  name="barcode"
                  defaultValue={p.barcode ?? ""}
                  placeholder="barcode"
                  className={`${editCls} mt-1 font-mono`}
                />
              </td>
              <td className="p-3 align-top">
                <input
                  form={fid}
                  name="product_name"
                  defaultValue={p.product_name ?? ""}
                  placeholder="name"
                  className={editCls}
                />
                <input
                  form={fid}
                  name="category"
                  defaultValue={p.category ?? ""}
                  placeholder="category"
                  className={`${editCls} mt-1`}
                />
              </td>
              <td className="p-3 align-top">
                <input
                  form={fid}
                  name="warehouse_location"
                  defaultValue={p.warehouse_location ?? ""}
                  placeholder="bin / shelf"
                  className={editCls}
                />
              </td>
              <td className="p-3 align-top">
                <input
                  form={fid}
                  name="cost"
                  type="number"
                  step="0.01"
                  min={0}
                  defaultValue={p.cost ?? ""}
                  placeholder="cost"
                  className={`${editCls} font-mono`}
                />
                <input
                  form={fid}
                  name="selling_price"
                  type="number"
                  step="0.01"
                  min={0}
                  defaultValue={p.selling_price ?? ""}
                  placeholder="price"
                  className={`${editCls} mt-1 font-mono`}
                />
              </td>
              <td className="p-3 align-top">
                <input
                  form={fid}
                  name="reorder_point"
                  type="number"
                  min={0}
                  defaultValue={p.reorder_point ?? ""}
                  placeholder="reorder"
                  className={`${editCls} font-mono`}
                />
              </td>
              <td className="p-3 align-top">
                <select form={fid} name="status" defaultValue={p.status} className={editCls}>
                  {STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="p-3 align-top">
                <div className="flex flex-col gap-1.5">
                  <button
                    form={fid}
                    type="submit"
                    className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                  >
                    Save
                  </button>
                  {p.status !== "archived" && (
                    <form action={archiveProduct}>
                      <input type="hidden" name="id" value={p.id} />
                      <input type="hidden" name="next_status" value="archived" />
                      <button
                        type="submit"
                        className="w-full rounded-md bg-charcoal-800 px-2 py-1 text-xs text-ink-muted hover:bg-charcoal-700"
                      >
                        Archive
                      </button>
                    </form>
                  )}
                  {canDelete && (
                    <form action={deleteProduct}>
                      <input type="hidden" name="id" value={p.id} />
                      <DeleteProductButton />
                    </form>
                  )}
                </div>
              </td>
              <td className="p-3 align-top">
                <RowActions {...rowActionProps("products", p as unknown as Record<string, unknown>, profile)} />
              </td>
            </tr>
          );
        })}
      </TableShell>

      {/* Product History Logs */}
      <div className="mt-8 mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Product history logs</h2>
        <span className="font-mono text-[11px] text-ink-dim">{history.length}</span>
      </div>
      <TableShell columns={["When", "Product", "By", "Changes"]}>
        {history.length === 0 && (
          <tr>
            <td colSpan={4} className="p-4 text-ink-muted">
              No edits recorded yet — every Product Master edit is logged here.
            </td>
          </tr>
        )}
        {history.map((h) => (
          <tr key={h.id} className={rowClass}>
            <td className="p-3 font-mono text-xs text-ink-muted">{manilaStamp(h.changed_at) ?? "—"}</td>
            <td className="p-3 text-ink">{productName(h.product_id)}</td>
            <td className="p-3 text-ink-muted">{h.user_id ? userName.get(h.user_id) ?? "—" : "system"}</td>
            <td className="p-3">
              <div className="flex flex-wrap gap-1">
                {Object.entries(h.changes ?? {}).map(([field, diff]) => (
                  <span
                    key={field}
                    className="rounded-md border border-charcoal-700/60 bg-charcoal-950/60 px-1.5 py-0.5 text-[11px] text-ink-muted"
                  >
                    <span className="text-ink-dim">{field}:</span>{" "}
                    <span className="line-through opacity-60">{fmtVal(diff?.old)}</span> →{" "}
                    <span className="text-ink">{fmtVal(diff?.new)}</span>
                  </span>
                ))}
              </div>
            </td>
          </tr>
        ))}
      </TableShell>
    </AppShell>
  );
}

// Render a jsonb-diff value compactly for the history log.
function fmtVal(v: unknown): string {
  if (v == null) return "∅";
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = String(v);
  return s.length > 24 ? `${s.slice(0, 24)}…` : s || "∅";
}
