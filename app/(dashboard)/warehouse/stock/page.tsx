import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { WarehouseTabs } from "@/components/warehouse/WarehouseTabs";
import { QuerySelect, QuerySearch } from "@/components/warehouse/QueryControls";
import { requireProfile, requireDepartment, isWarehouseWriter } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { intOrDash } from "@/lib/metrics/format";
import { manilaStamp } from "@/lib/metrics/windows";
import { last30 } from "@/lib/metrics/windows";
import { MOVEMENT_LABEL as VELOCITY_MOVEMENT_LABEL, movementTone } from "@/lib/warehouse/velocity";
import {
  computeInventoryKpis,
  loadInventory,
  MOVEMENT_TYPES,
  MOVEMENT_LABEL,
  type InventoryRow,
  type MovementType,
  type Shim,
} from "@/lib/warehouse/inventory";
import { recordMovement, recountStock, updateLevelFields } from "@/lib/warehouse/mutations";
import { revalidatePath } from "next/cache";

// Warehouse — Stock. The operational inventory module: per-SKU on-hand picture
// (current / available / reserved / damaged / in-transit / restock requirement /
// reorder level / last updated), the full movement ledger with responsible
// personnel, and the three alerts — low stock, out of stock, and ledger
// discrepancies. Every figure derives from stock_levels + stock_movements
// through the ONE shared inventory layer (lib/warehouse/inventory). Read-open to
// every role; recording movements and editing levels is Warehouse-team +
// leadership only (RLS on stock_levels / stock_movements is the real guard).

export const dynamic = "force-dynamic";

const MOVEMENT_TYPE_SET = new Set(MOVEMENT_TYPES.map((t) => t.value));

const STATUSES: { value: string; label: string }[] = [
  { value: "all", label: "All products" },
  { value: "low", label: "Low stock" },
  { value: "out", label: "Out of stock" },
  { value: "discrepancy", label: "Discrepancies" },
  { value: "uncounted", label: "No count yet" },
];

function pick(v: string | undefined, allowed: string[], fallback: string): string {
  return v && allowed.includes(v) ? v : fallback;
}

function intForm(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? n : null;
}

// ── Server actions (Warehouse team + leadership) ─────────────────────────────

async function recordMovementAction(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  if (!isWarehouseWriter(profile)) return;

  const productId = String(formData.get("product_id") ?? "");
  const brandId = String(formData.get("brand_id") ?? "") || null;
  const type = String(formData.get("movement_type") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;
  const qty = intForm(formData.get("qty"));
  if (!productId || !MOVEMENT_TYPE_SET.has(type as MovementType) || qty == null) return;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  if (type === "manual_correction") {
    // qty is the physically-counted absolute on-hand.
    if (qty < 0) return;
    await recountStock(db, { orgId: profile.org_id, productId, brandId, countedStock: qty, note });
  } else {
    // adjustment may be signed; the directional types take a positive magnitude.
    if (type !== "adjustment" && qty <= 0) return;
    if (type === "adjustment" && qty === 0) return;
    await recordMovement(db, {
      orgId: profile.org_id,
      productId,
      brandId,
      movementType: type as Exclude<MovementType, "manual_correction">,
      qty,
      note,
    });
  }
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/overview");
  revalidatePath("/warehouse/intelligence");
}

async function setLevelFieldsAction(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  if (!isWarehouseWriter(profile)) return;

  const productId = String(formData.get("product_id") ?? "");
  const brandId = String(formData.get("brand_id") ?? "") || null;
  if (!productId) return;

  const supabase = createServerSupabaseClient();
  await updateLevelFields(supabase as unknown as Shim, {
    orgId: profile.org_id,
    productId,
    brandId,
    reserved: intForm(formData.get("reserved")),
    damaged: intForm(formData.get("damaged")),
    inTransit: intForm(formData.get("in_transit")),
    // reorder_level is intentionally clearable: an empty field sets it null.
    reorderLevel: intForm(formData.get("reorder_level")),
  });
  revalidatePath("/warehouse/stock");
  revalidatePath("/warehouse/overview");
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function WarehouseStockPage({
  searchParams,
}: {
  searchParams: { brand?: string; status?: string; q?: string };
}) {
  // Warehouse (Commerce operating surface) — department-scoped to E-Commerce Ops
  // + Warehouse & Fulfillment; leadership bypasses. Write stays gated by
  // isWarehouseWriter below; RLS on stock_levels/movements is the real guard.
  const profile = await requireModule("/warehouse/stock");
  const canWrite = isWarehouseWriter(profile);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const win = last30();
  const { rows, brands, movements } = await loadInventory(db, profile.org_id, win.start, win.end);
  const kpis = computeInventoryKpis(rows);

  // Personnel names for the movement ledger.
  const { data: userRows } = await supabase.from("users").select("id, full_name").order("full_name");
  const userName = new Map(
    ((userRows ?? []) as unknown as { id: string; full_name: string }[]).map((u) => [u.id, u.full_name])
  );

  const status = pick(searchParams.status, STATUSES.map((s) => s.value), "all");
  const brandFilter =
    searchParams.brand && brands.some((b) => b.id === searchParams.brand) ? searchParams.brand : "all";
  const q = (searchParams.q ?? "").trim().toLowerCase();

  // Universal search over SKU / name / barcode / warehouse location.
  const matchesQuery = (r: InventoryRow): boolean => {
    if (!q) return true;
    const hay = [
      r.product.sku,
      r.product.product_name ?? "",
      r.product.barcode ?? "",
      r.product.warehouse_location ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  };

  let shown = rows.filter((r) => {
    if (brandFilter !== "all" && r.product.brand_id !== brandFilter) return false;
    if (status === "low" && !r.low) return false;
    if (status === "out" && !r.zero) return false;
    if (status === "discrepancy" && !r.discrepancy) return false;
    if (status === "uncounted" && r.level != null) return false;
    if (!matchesQuery(r)) return false;
    return true;
  });

  // Sort: problems first (discrepancy, then out, then low), then by name.
  shown = [...shown].sort((a, b) => {
    const score = (r: InventoryRow) => (r.discrepancy ? 0 : r.zero ? 1 : r.low ? 2 : 3);
    const d = score(a) - score(b);
    if (d !== 0) return d;
    return (a.product.product_name ?? a.product.sku).localeCompare(b.product.product_name ?? b.product.sku);
  });

  // Alerts across the whole catalogue (before filtering).
  const alerts = rows.filter((r) => r.low || r.zero || r.discrepancy);

  // Movement ledger — newest first, scoped to the shown products when a filter
  // narrows the view, else the whole org. Capped for the page.
  const shownIds = new Set(shown.map((r) => r.product.id));
  const nameById = new Map(rows.map((r) => [r.product.id, r.product.product_name?.trim() || r.product.sku]));
  const narrowed = brandFilter !== "all" || status !== "all" || q !== "";
  const ledger = movements.filter((m) => !narrowed || shownIds.has(m.product_id)).slice(0, 60);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse", "Stock"]} profile={profile}>
      <PageHeader
        title="Warehouse — Stock"
        subtitle="Per-SKU on-hand, the movement ledger and reorder / discrepancy alerts — one home for every stock fact."
      />
      <WarehouseTabs active="stock" />

      {/* Tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Counted SKUs" value={kpis.countedSkus} hint={`of ${rows.length} products`} />
        <StatTile
          label="Low stock"
          value={kpis.lowStock}
          valueClassName={kpis.lowStock > 0 ? "text-amber-300" : "text-ink"}
          hint="available ≤ reorder level"
        />
        <StatTile
          label="Out of stock"
          value={kpis.outOfStock}
          valueClassName={kpis.outOfStock > 0 ? "text-red-300" : "text-ink"}
          hint="available at zero"
        />
        <StatTile
          label="Discrepancies"
          value={kpis.discrepancies}
          valueClassName={kpis.discrepancies > 0 ? "text-red-300" : "text-ink"}
          hint="ledger ≠ counted"
        />
      </div>

      {/* Filters — instant refresh, no reload */}
      <div className="mb-6 flex flex-wrap items-end gap-2">
        <QuerySelect
          name="status"
          label="Status"
          value={status}
          options={STATUSES}
          resetKeys={[]}
        />
        <QuerySelect
          name="brand"
          label="Brand"
          value={brandFilter}
          options={[{ value: "all", label: "All brands" }, ...brands.map((b) => ({ value: b.id, label: b.name }))]}
        />
        <QuerySearch
          name="q"
          label="Search"
          value={searchParams.q ?? ""}
          placeholder="SKU, name, barcode, location…"
          className="min-w-[220px]"
        />
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <SectionCard title={`Alerts (${alerts.length})`} className="mb-8">
          <div className="space-y-2">
            {alerts.slice(0, 40).map((r) => (
              <div
                key={r.product.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3"
              >
                <div className="min-w-0">
                  <span className="text-sm text-ink">{r.product.product_name?.trim() || r.product.sku}</span>
                  <span className="ml-2 font-mono text-[11px] text-ink-dim">
                    {r.product.sku}
                    {r.brandName ? ` · ${r.brandName}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {r.zero && <Badge tone="red">Out of stock</Badge>}
                  {r.low && !r.zero && <Badge tone="amber">Low stock</Badge>}
                  {r.discrepancy && (
                    <Badge tone="red">
                      Discrepancy · ledger {intOrDash(r.ledgerNet)} vs {intOrDash(r.current)}
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Inventory table */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">
          Inventory{" "}
          <span className="font-mono text-[11px] text-ink-dim">
            {shown.length}/{rows.length}
          </span>
        </h2>
      </div>
      <TableShell
        columns={[
          "Product",
          "Current",
          "Available",
          "Reserved",
          "Damaged",
          "In transit",
          "Restock req.",
          "Reorder",
          "Movement",
          "Last updated",
          ...(canWrite ? ["Manage"] : []),
        ]}
      >
        {shown.length === 0 && (
          <tr>
            <td colSpan={canWrite ? 11 : 10} className="p-4 text-ink-muted">
              No products match these filters.
            </td>
          </tr>
        )}
        {shown.map((r) => (
          <StockRowView key={r.product.id} row={r} canWrite={canWrite} />
        ))}
      </TableShell>

      {/* Movement ledger */}
      <div className="mt-8 mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">
          Inventory movement history{" "}
          <span className="font-mono text-[11px] text-ink-dim">
            {ledger.length}
            {narrowed ? " (filtered)" : ""}
          </span>
        </h2>
      </div>
      <TableShell columns={["When", "Product", "Type", "Qty", "Personnel", "Note"]}>
        {ledger.length === 0 && (
          <tr>
            <td colSpan={6} className="p-4 text-ink-muted">
              No movements recorded yet.
            </td>
          </tr>
        )}
        {ledger.map((m) => (
          <tr key={m.id} className={rowClass}>
            <td className="p-3 font-mono text-xs text-ink-muted">{manilaStamp(m.created_at) ?? "—"}</td>
            <td className="p-3 text-ink">{nameById.get(m.product_id) ?? "—"}</td>
            <td className="p-3">
              <Badge tone={m.qty < 0 ? "amber" : "teal"}>{MOVEMENT_LABEL[m.movement_type]}</Badge>
            </td>
            <td className="p-3 font-mono text-ink">
              {m.qty > 0 ? `+${intOrDash(m.qty)}` : intOrDash(m.qty)}
            </td>
            <td className="p-3 text-ink-muted">
              {m.personnel_id ? userName.get(m.personnel_id) ?? "—" : "—"}
            </td>
            <td className="p-3 text-xs text-ink-muted">{m.note ?? "—"}</td>
          </tr>
        ))}
      </TableShell>
    </AppShell>
  );
}

// One inventory row + a per-row disclosure with the movement recorder and level
// editor (writer only). Read figures show honest "—" when there is no count.
function StockRowView({ row, canWrite }: { row: InventoryRow; canWrite: boolean }) {
  const { product, level } = row;
  const name = product.product_name?.trim() || product.sku;
  const tint = row.discrepancy ? "bg-red-500/[0.06]" : row.zero ? "bg-red-500/[0.05]" : row.low ? "bg-amber-500/[0.05]" : "";

  const num = (v: number | null) => (v == null ? <span className="text-ink-dim">—</span> : intOrDash(v));
  const cellCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink";

  return (
    <>
      <tr className={`${rowClass} ${tint}`}>
        <td className="p-3 align-top">
          <div className="text-ink">{name}</div>
          <div className="font-mono text-[11px] text-ink-dim">
            {product.sku}
            {row.brandName ? ` · ${row.brandName}` : ""}
            {product.warehouse_location ? ` · ${product.warehouse_location}` : ""}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {row.zero && <Badge tone="red">Out</Badge>}
            {row.low && !row.zero && <Badge tone="amber">Low</Badge>}
            {row.discrepancy && <Badge tone="red">Discrepancy</Badge>}
          </div>
        </td>
        <td className="p-3 align-top font-mono text-ink">{num(row.current)}</td>
        <td className="p-3 align-top font-mono text-ink">{num(row.available)}</td>
        <td className="p-3 align-top font-mono text-ink-muted">{num(row.reserved)}</td>
        <td className="p-3 align-top font-mono text-ink-muted">{num(row.damaged)}</td>
        <td className="p-3 align-top font-mono text-ink-muted">{num(row.inTransit)}</td>
        <td className="p-3 align-top font-mono">
          {row.restockRequirement == null ? (
            <span className="text-ink-dim">—</span>
          ) : row.restockRequirement > 0 ? (
            <span className="text-amber-300">{intOrDash(row.restockRequirement)}</span>
          ) : (
            <span className="text-ink">0</span>
          )}
        </td>
        <td className="p-3 align-top font-mono text-ink">{num(row.reorderLevel)}</td>
        <td className="p-3 align-top">
          <Badge tone={movementTone(row.movement)}>{VELOCITY_MOVEMENT_LABEL[row.movement]}</Badge>
          {row.outUnits > 0 && (
            <div className="mt-1 font-mono text-[10px] text-ink-dim">{intOrDash(row.outUnits)} out /30d</div>
          )}
        </td>
        <td className="p-3 align-top text-xs text-ink-muted">
          {row.lastUpdatedAt ? manilaStamp(row.lastUpdatedAt) : <span className="text-ink-dim">—</span>}
        </td>
        {canWrite && (
          <td className="p-3 align-top">
            <details>
              <summary className="cursor-pointer text-xs text-teal-300 hover:text-ink">Manage</summary>
              <div className="mt-2 w-64 space-y-3">
                {/* Record a movement */}
                <form action={recordMovementAction} className="space-y-1.5">
                  <input type="hidden" name="product_id" value={product.id} />
                  <input type="hidden" name="brand_id" value={product.brand_id ?? ""} />
                  <div className="flex gap-1.5">
                    <select name="movement_type" defaultValue="stock_in" className={`${cellCls} flex-1`}>
                      {MOVEMENT_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <input name="qty" type="number" placeholder="qty" className={`${cellCls} w-20`} />
                  </div>
                  <input name="note" placeholder="note (optional)" className={`${cellCls} w-full`} />
                  <button
                    type="submit"
                    className="w-full rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                  >
                    Record movement
                  </button>
                  <p className="text-[10px] text-ink-dim">
                    Manual Correction sets the counted absolute; Adjustment takes a ± value.
                  </p>
                </form>

                {/* Set level fields */}
                <form action={setLevelFieldsAction} className="space-y-1.5 border-t border-charcoal-800 pt-2">
                  <input type="hidden" name="product_id" value={product.id} />
                  <input type="hidden" name="brand_id" value={product.brand_id ?? ""} />
                  <div className="grid grid-cols-2 gap-1.5">
                    <label className="text-[10px] text-ink-dim">
                      Reserved
                      <input
                        name="reserved"
                        type="number"
                        min={0}
                        defaultValue={level?.reserved_stock ?? ""}
                        className={`${cellCls} w-full`}
                      />
                    </label>
                    <label className="text-[10px] text-ink-dim">
                      Damaged
                      <input
                        name="damaged"
                        type="number"
                        min={0}
                        defaultValue={level?.damaged_stock ?? ""}
                        className={`${cellCls} w-full`}
                      />
                    </label>
                    <label className="text-[10px] text-ink-dim">
                      In transit
                      <input
                        name="in_transit"
                        type="number"
                        min={0}
                        defaultValue={level?.in_transit ?? ""}
                        className={`${cellCls} w-full`}
                      />
                    </label>
                    <label className="text-[10px] text-ink-dim">
                      Reorder level
                      <input
                        name="reorder_level"
                        type="number"
                        min={0}
                        defaultValue={level?.reorder_level ?? ""}
                        className={`${cellCls} w-full`}
                      />
                    </label>
                  </div>
                  <button
                    type="submit"
                    className="w-full rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                  >
                    Save levels
                  </button>
                </form>
              </div>
            </details>
          </td>
        )}
      </tr>
    </>
  );
}
