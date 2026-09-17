import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { WarehouseTabs } from "@/components/warehouse/WarehouseTabs";
import { StatLink } from "@/components/warehouse/StatLink";
import { requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { intOrDash } from "@/lib/metrics/format";
import { last7, last30, todayManila } from "@/lib/metrics/windows";
import { DateRangeControls } from "../../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import {
  computeInventoryKpis,
  loadInventory,
  movementsInWindow,
  sumByType,
  type Shim,
} from "@/lib/warehouse/inventory";

// Warehouse — Overview. The module's landing dashboard. Every card is DERIVED
// from the domain tables (products / stock_levels / stock_movements) at read
// time — nothing is re-encoded into product_metrics. Honest nulls: Total
// Available Stocks reads "—" until at least one SKU has been counted. Each card
// links into the module it drills into.

export const dynamic = "force-dynamic";

export default async function WarehouseOverviewPage({
  searchParams,
}: {
  searchParams?: DateRangeSearchParams;
}) {
  // Warehouse (Commerce operating surface) — department-scoped to E-Commerce Ops
  // + Warehouse & Fulfillment; leadership bypasses. RLS still scopes rows.
  const profile = await requireModule("/warehouse/overview");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Shared date-range control (defaults to trailing 30 days). The Warehouse
  // Operations movement figures re-slice to the selected window; inventory KPIs
  // are a live snapshot. Brand/Compare aren't wired here, so both are hidden.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "last_30" });
  const from = dr.range.start;
  const to = dr.range.end;

  const { rows, movements } = await loadInventory(db, profile.org_id, from, to);
  const kpis = computeInventoryKpis(rows);

  // Movement-derived operations figures over the selected window.
  const windowMoves = movementsInWindow(movements, from, to);
  const incoming = sumByType(windowMoves, ["stock_in"]);
  const outgoing = sumByType(windowMoves, ["stock_out"]);

  // Daily / weekly / monthly movement counts — fixed trailing windows,
  // independent of the date filter (a quick "how busy has the floor been" read).
  const today = todayManila();
  const w7 = last7();
  const w30 = last30();
  const dailyCount = movementsInWindow(movements, today, today).length;
  const weeklyCount = movementsInWindow(movements, w7.start, w7.end).length;
  const monthlyCount = movementsInWindow(movements, w30.start, w30.end).length;

  const hasAnyProducts = rows.length > 0;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse", "Overview"]} profile={profile}>
      <PageHeader title="Warehouse — Overview" />
      <WarehouseTabs active="overview" />

      {/* Shared date-range control — the Warehouse Operations figures respect the
          selected window. Persisted in the URL (survives refresh). */}
      <DateRangeControls {...dr.controlProps} brands={[]} showBrand={false} showCompare={false} />

      {!hasAnyProducts ? (
        <SectionCard title="No products yet">
          <p className="text-sm text-ink-muted">
            The product master is empty. Add products on the{" "}
            <a href="/warehouse/products" className="text-teal-300 underline hover:text-ink">
              Product Master
            </a>{" "}
            tab, then record stock on the Stock tab — the KPIs here fill in automatically.
          </p>
        </SectionCard>
      ) : (
        <>
          {/* Inventory */}
          <h2 className="mb-3 text-sm font-semibold text-ink">Inventory</h2>
          <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatLink
              label="Active Brands"
              value={intOrDash(kpis.activeBrands)}
              hint="brands with an active SKU"
              href="/warehouse/intelligence"
            />
            <StatLink
              label="Active SKUs"
              value={intOrDash(kpis.activeSkus)}
              hint={`of ${rows.length} products`}
              href="/warehouse/products"
            />
            <StatLink
              label="Available Stocks"
              value={kpis.availableStocks == null ? "—" : intOrDash(kpis.availableStocks)}
              hint={
                kpis.availableStocks == null
                  ? "no counts yet"
                  : `${kpis.countedSkus} SKU${kpis.countedSkus === 1 ? "" : "s"} counted`
              }
              href="/warehouse/stock"
            />
            <StatLink
              label="Low Stock"
              value={intOrDash(kpis.lowStock)}
              valueClassName={kpis.lowStock > 0 ? "text-amber-300" : "text-ink"}
              hint="available ≤ reorder level"
              href="/warehouse/stock?status=low"
            />
            <StatLink
              label="Out of Stock"
              value={intOrDash(kpis.outOfStock)}
              valueClassName={kpis.outOfStock > 0 ? "text-red-300" : "text-ink"}
              hint="available at zero"
              href="/warehouse/stock?status=out"
            />
          </div>

          {/* Warehouse Operations */}
          <h2 className="mb-3 text-sm font-semibold text-ink">
            Warehouse Operations{" "}
            <span className="font-mono text-[11px] text-ink-dim">
              {from} → {to}
            </span>
          </h2>
          <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatLink
              label="Incoming"
              value={intOrDash(incoming)}
              valueClassName="text-teal-300"
              hint="units in (period)"
              href="/warehouse/stock"
            />
            <StatLink
              label="Outgoing"
              value={intOrDash(outgoing)}
              valueClassName="text-ink"
              hint="units out (period)"
              href="/warehouse/stock"
            />
            <StatLink
              label="Daily Movement"
              value={intOrDash(dailyCount)}
              hint="movements today"
              href="/warehouse/stock"
            />
            <StatLink
              label="Weekly Movement"
              value={intOrDash(weeklyCount)}
              hint="last 7 days"
              href="/warehouse/stock"
            />
            <StatLink
              label="Monthly Movement"
              value={intOrDash(monthlyCount)}
              hint="last 30 days"
              href="/warehouse/stock"
            />
          </div>

          {/* Discrepancy callout — only when the ledger disagrees with a count. */}
          {kpis.discrepancies > 0 && (
            <div className="mb-8 rounded-lg border border-red-500/40 bg-red-500/[0.06] p-4">
              <p className="text-sm text-red-200">
                {kpis.discrepancies} SKU{kpis.discrepancies === 1 ? "" : "s"} show a stock
                discrepancy — the movement ledger doesn't reconcile with the counted on-hand.{" "}
                <a href="/warehouse/stock?status=discrepancy" className="underline hover:text-ink">
                  Review on the Stock tab
                </a>
                .
              </p>
            </div>
          )}

          {/* RTS / Case Monitoring — link into the Returns & RTS module. */}
          <h2 className="mb-3 text-sm font-semibold text-ink">Returns &amp; Case Monitoring</h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <StatLink
              label="RTS Overview"
              value="Open module"
              hint="returns & RTS tracker"
              href="/warehouse"
            />
            <StatLink
              label="Case Monitoring"
              value="Open module"
              hint="CSR follow-up & fault analysis"
              href="/warehouse"
            />
          </div>
        </>
      )}
    </AppShell>
  );
}
