import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { WarehouseTabs } from "@/components/warehouse/WarehouseTabs";
import { QuerySelect } from "@/components/warehouse/QueryControls";
import { ScanWarehouseButton } from "@/components/warehouse/ScanWarehouseButton";
import { ScanQualityButton } from "@/components/warehouse/ScanQualityButton";
import { requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso, pesoOrDash, intOrDash } from "@/lib/metrics/format";
import { manilaStamp, last30 } from "@/lib/metrics/windows";
import { loadWarehouseIntelligence } from "@/lib/warehouse/data";
import { MOVEMENT_LABEL, movementTone, type MovementClass } from "@/lib/warehouse/velocity";
import {
  loadInventory,
  dailyMovementSeries,
  topByOutbound,
  movementsInWindow,
  type InventoryRow,
  type Shim,
} from "@/lib/warehouse/inventory";

// Warehouse — Product Intelligence. Per-product analytics joined across
// products + stock_levels + product_metrics: brand, name, SKU, category, status,
// current / reserved / available inventory, a Fast/Slow/Dead-moving indicator
// derived from stock_movements velocity over the period, and the last inventory
// update. Three charts (Inventory Trend, Stock Consumption Rate, Product
// Performance Ranking) derive from the movement ledger. The routing suggestion
// and value-at-risk come from the shared velocity/routing engine, which now
// reads the same stock_levels home — so the view and every drafted action agree.

export const dynamic = "force-dynamic";

const MOVEMENTS: { value: string; label: string }[] = [
  { value: "all", label: "All movement" },
  { value: "fast", label: "Fast" },
  { value: "healthy", label: "Healthy" },
  { value: "slow", label: "Slow" },
  { value: "nonmoving", label: "Dead-moving" },
  { value: "unknown", label: "No data" },
];
const SORTS: { value: string; label: string }[] = [
  { value: "out_desc", label: "Most outbound" },
  { value: "available_asc", label: "Lowest available" },
  { value: "var_desc", label: "Value at risk" },
  { value: "name", label: "Name" },
];

function pick(v: string | undefined, allowed: string[], fallback: string): string {
  return v && allowed.includes(v) ? v : fallback;
}

const BIG = Number.MAX_SAFE_INTEGER;

export default async function ProductIntelligencePage({
  searchParams,
}: {
  searchParams: { movement?: string; brand?: string; sort?: string; status?: string };
}) {
  // Warehouse (Commerce operating surface) — department-scoped to E-Commerce Ops
  // + Warehouse & Fulfillment; leadership bypasses. RLS still scopes rows.
  const profile = await requireModule("/warehouse/intelligence");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const win = last30();
  const [inv, intel] = await Promise.all([
    loadInventory(db, profile.org_id, win.start, win.end),
    loadWarehouseIntelligence(db, profile.org_id),
  ]);
  const { rows, brands, movements } = inv;

  // Join the routing / value-at-risk facts by product id.
  const intelById = new Map(intel.rows.map((r) => [r.product.id, r]));

  const movement = pick(searchParams.movement, MOVEMENTS.map((m) => m.value), "all");
  const sort = pick(searchParams.sort, SORTS.map((s) => s.value), "out_desc");
  const brandFilter =
    searchParams.brand && brands.some((b) => b.id === searchParams.brand) ? searchParams.brand : "all";
  const statusFilter = searchParams.status ?? "all";

  // Tiles — movement classes from the ledger (Fast / Slow / Dead-moving).
  const countBy = (m: MovementClass) => rows.filter((r) => r.movement === m).length;
  const totalVar = intel.rows.reduce((a, r) => a + (r.aging.valueAtRisk ?? 0), 0);
  const anyVar = intel.rows.some((r) => r.aging.valueAtRisk != null);

  // Filter.
  const statuses = Array.from(new Set(rows.map((r) => r.product.status))).sort();
  let shown = rows.filter((r) => {
    if (movement !== "all" && r.movement !== movement) return false;
    if (brandFilter !== "all" && r.product.brand_id !== brandFilter) return false;
    if (statusFilter !== "all" && r.product.status !== statusFilter) return false;
    return true;
  });

  shown = [...shown].sort((a, b) => {
    switch (sort) {
      case "out_desc":
        return b.outUnits - a.outUnits;
      case "available_asc":
        return (a.available ?? BIG) - (b.available ?? BIG);
      case "var_desc":
        return (intelById.get(b.product.id)?.aging.valueAtRisk ?? -1) -
          (intelById.get(a.product.id)?.aging.valueAtRisk ?? -1);
      default:
        return (a.product.product_name ?? a.product.sku).localeCompare(
          b.product.product_name ?? b.product.sku
        );
    }
  });

  // Chart data (from the ledger over the trailing 30 days).
  const windowMoves = movementsInWindow(movements, win.start, win.end);
  const series = dailyMovementSeries(windowMoves, win.start, win.end);
  const ranking = topByOutbound(rows, 8);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse", "Product Intelligence"]} profile={profile}>
      <PageHeader
        title="Warehouse — Product Intelligence"
        subtitle="Per-SKU inventory, movement class and trends — derived from the stock and movement tables."
        action={
          <div className="flex flex-wrap items-start justify-end gap-2">
            <ScanQualityButton />
            <ScanWarehouseButton />
          </div>
        }
      />
      <WarehouseTabs active="intelligence" />

      {/* Tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Fast movers" value={countBy("fast")} valueClassName="text-teal-300" />
        <StatTile label="Slow movers" value={countBy("slow")} valueClassName="text-amber-300" />
        <StatTile label="Dead-moving" value={countBy("nonmoving")} valueClassName="text-red-300" />
        <StatTile
          label="Total value at risk"
          value={anyVar ? peso(totalVar) : "—"}
          hint={anyVar ? "stock × unit value" : "no stock/value data yet"}
        />
      </div>

      {/* Charts */}
      <div className="mb-8 grid gap-4 lg:grid-cols-3">
        <SectionCard title="Inventory trend (net movement)">
          <TrendChart series={series} />
        </SectionCard>
        <SectionCard title="Stock consumption rate">
          <ConsumptionChart series={series} />
        </SectionCard>
        <SectionCard title="Product performance ranking">
          <RankingChart rows={ranking} />
        </SectionCard>
      </div>

      {/* Filters — instant refresh */}
      <div className="mb-6 flex flex-wrap items-end gap-2">
        <QuerySelect name="movement" label="Movement" value={movement} options={MOVEMENTS} />
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
          options={[{ value: "all", label: "All statuses" }, ...statuses.map((s) => ({ value: s, label: s }))]}
        />
        <QuerySelect name="sort" label="Sort" value={sort} options={SORTS} />
        <span className="pb-2 text-[11px] text-ink-dim">
          Window {win.start} → {win.end} (Asia/Manila)
        </span>
      </div>

      {rows.length === 0 ? (
        <SectionCard title="No products yet">
          <p className="text-sm text-ink-muted">
            The product master is empty. Add products on the{" "}
            <a href="/warehouse/products" className="text-teal-300 underline hover:text-ink">
              Product Master
            </a>{" "}
            tab, then record stock — analytics fill in automatically.
          </p>
        </SectionCard>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              Products{" "}
              <span className="font-mono text-[11px] text-ink-dim">
                {shown.length}/{rows.length}
              </span>
            </h2>
          </div>
          <TableShell
            columns={[
              "Product",
              "Status",
              "Current",
              "Reserved",
              "Available",
              "Movement",
              "Value at risk",
              "Last update",
              "Suggested",
            ]}
          >
            {shown.length === 0 && (
              <tr>
                <td colSpan={9} className="p-4 text-ink-muted">
                  No products match these filters.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <IntelRow key={r.product.id} row={r} valueAtRisk={intelById.get(r.product.id)?.aging.valueAtRisk ?? null} route={intelById.get(r.product.id)?.route ?? null} />
            ))}
          </TableShell>
        </>
      )}
    </AppShell>
  );
}

function num(v: number | null) {
  return v == null ? <span className="text-ink-dim">—</span> : intOrDash(v);
}

function IntelRow({
  row,
  valueAtRisk,
  route,
}: {
  row: InventoryRow;
  valueAtRisk: number | null;
  route: "replenish" | "push" | null;
}) {
  const { product } = row;
  const name = product.product_name?.trim() || product.sku;
  return (
    <tr className={rowClass}>
      <td className="p-3 align-top">
        <div className="text-ink">{name}</div>
        <div className="font-mono text-[11px] text-ink-dim">
          {product.sku}
          {product.variant ? ` · ${product.variant}` : ""}
          {row.brandName ? ` · ${row.brandName}` : ""}
          {product.category ? ` · ${product.category}` : ""}
        </div>
      </td>
      <td className="p-3 align-top">
        <Badge tone={product.status === "active" ? "teal" : "muted"}>{product.status}</Badge>
      </td>
      <td className="p-3 align-top font-mono text-ink">{num(row.current)}</td>
      <td className="p-3 align-top font-mono text-ink-muted">{num(row.reserved)}</td>
      <td className="p-3 align-top font-mono text-ink">{num(row.available)}</td>
      <td className="p-3 align-top">
        <Badge tone={movementTone(row.movement)}>{MOVEMENT_LABEL[row.movement]}</Badge>
        {row.outUnits > 0 && (
          <div className="mt-1 font-mono text-[10px] text-ink-dim">{intOrDash(row.outUnits)} out /30d</div>
        )}
      </td>
      <td className="p-3 align-top font-mono text-ink">{pesoOrDash(valueAtRisk)}</td>
      <td className="p-3 align-top text-xs text-ink-muted">
        {row.lastUpdatedAt ? manilaStamp(row.lastUpdatedAt) : <span className="text-ink-dim">—</span>}
      </td>
      <td className="p-3 align-top">
        {route === "replenish" ? (
          <Badge tone="teal">Replenish</Badge>
        ) : route === "push" ? (
          <Badge tone="red">Push to sell</Badge>
        ) : (
          <span className="text-xs text-ink-dim">—</span>
        )}
      </td>
    </tr>
  );
}

// ── Charts (self-contained; no external library) ──────────────────────────────

// Inventory trend: cumulative net movement across the window, as an SVG line.
function TrendChart({ series }: { series: { day: string; net: number }[] }) {
  if (series.length === 0) return <p className="text-sm text-ink-muted">No movement in the period.</p>;
  let running = 0;
  const cum = series.map((s) => (running += s.net));
  const min = Math.min(0, ...cum);
  const max = Math.max(0, ...cum);
  const span = max - min || 1;
  const W = 100;
  const H = 40;
  const pts = cum
    .map((v, i) => {
      const x = series.length === 1 ? 0 : (i / (series.length - 1)) * W;
      const y = H - ((v - min) / span) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const end = cum[cum.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-24 w-full">
        <polyline points={pts} fill="none" stroke="#2dd4bf" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="mt-2 text-xs text-ink-muted">
        Net over {series.length}d:{" "}
        <span className={`font-mono ${end >= 0 ? "text-teal-300" : "text-amber-300"}`}>
          {end >= 0 ? "+" : ""}
          {intOrDash(end)}
        </span>{" "}
        units
      </p>
    </div>
  );
}

// Stock consumption rate: outbound units per day as bars.
function ConsumptionChart({ series }: { series: { day: string; outUnits: number }[] }) {
  const max = series.reduce((m, s) => Math.max(m, s.outUnits), 0);
  const total = series.reduce((a, s) => a + s.outUnits, 0);
  if (max === 0) return <p className="text-sm text-ink-muted">No outbound movement in the period.</p>;
  return (
    <div>
      <div className="flex h-24 items-end gap-[2px]">
        {series.map((s) => (
          <div
            key={s.day}
            title={`${s.day}: ${s.outUnits} out`}
            className="flex-1 rounded-t-sm bg-amber-500/70"
            style={{ height: `${Math.max(2, (s.outUnits / max) * 100)}%` }}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        {intOrDash(total)} units out over {series.length}d · avg{" "}
        <span className="font-mono text-ink">{(total / series.length).toFixed(1)}</span>/day
      </p>
    </div>
  );
}

// Product performance ranking: top products by outbound units.
function RankingChart({ rows }: { rows: InventoryRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-ink-muted">No outbound movement yet.</p>;
  const max = rows.reduce((m, r) => Math.max(m, r.outUnits), 0);
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const pct = max > 0 ? Math.round((r.outUnits / max) * 100) : 0;
        return (
          <div key={r.product.id}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs">
              <span className="truncate text-ink-muted">{r.product.product_name?.trim() || r.product.sku}</span>
              <span className="shrink-0 font-mono text-ink">{intOrDash(r.outUnits)}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
              <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
