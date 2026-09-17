// lib/warehouse/data.ts — the server-side data layer for the Intelligent
// Warehouse. It loads the product master, the trailing stock/sales signals
// (product_metrics + tiktok_product_performance) and the brand names, then
// computes one ProductIntel per product through the SHARED velocity engine and
// the SHARED router. The Product Intelligence view AND the "Scan warehouse"
// producer both call loadWarehouseIntelligence, so a product's movement class,
// days-of-cover, aging, value-at-risk and route are computed in exactly one
// place — no duplicate math between what a human sees and what Tony drafts.
//
// Real data only. A product with no metrics row gets stock=null → movement
// 'unknown' and every derived figure null; the view renders those as honest
// "no data" / "not set" states rather than zeros.
//
// The provisioned tables aren't in the generated Database types, so callers pass
// the same cast shim the rest of the OS uses.

import { todayManila, last30 } from "@/lib/metrics/windows";
import {
  computeVelocity,
  type Velocity,
} from "./velocity";
import {
  routeProduct,
  type AgingFacts,
  type RoutableProduct,
  type WarehouseRoute,
} from "./actions";

type Shim = { from: (t: string) => any };

export interface ProductRow {
  id: string;
  org_id: string;
  brand_id: string | null;
  sku: string;
  product_name: string | null;
  category: string | null;
  is_fragile: boolean;
  is_perishable: boolean;
  is_high_value: boolean;
  unit_value: number | null;
  stocked_at: string | null; // YYYY-MM-DD
  expiry_date: string | null; // YYYY-MM-DD
  reorder_point: number | null;
  target_cover_days: number;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrandLite {
  id: string;
  name: string;
}

// The fully-computed intelligence row — everything the view shows and the scan
// routes on, for one product.
export interface ProductIntel {
  product: ProductRow;
  brandName: string | null;
  velocity: Velocity;
  aging: AgingFacts;
  returns30d: number | null; // trailing returns (product_metrics only); null = no data
  productRating: number | null; // latest product_metrics.product_rating
  route: WarehouseRoute;
  // On-hand facts from the stock_levels home (null when there is no count yet).
  reserved: number | null;
  available: number | null;
}

export interface WarehouseIntelligence {
  rows: ProductIntel[];
  brands: BrandLite[];
  windowStart: string;
  windowEnd: string;
}

// A stock/sales key. brand_id + case-folded sku, so a SKU is matched to its
// metrics within the same brand (and null-brand products match null-brand rows).
function key(brandId: string | null, sku: string | null | undefined): string {
  return `${brandId ?? ""}::${(sku ?? "").trim().toLowerCase()}`;
}

// Whole days from `fromYmd` to `toYmd` (toYmd − fromYmd), using the calendar-date
// parts only so no timezone re-shift sneaks in. Positive when toYmd is later.
function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

type MetricRow = {
  brand_id: string | null;
  sku: string | null;
  period_start: string | null;
  period_end: string | null;
  units: number | null;
  returns: number | null;
  product_rating: number | null;
  stock: number | null;
  created_at: string | null;
};

type TiktokRow = {
  brand_id: string | null;
  sku: string | null;
  stat_date: string;
  units: number | null;
};

// Load + compute the full intelligence set for the caller's org.
export async function loadWarehouseIntelligence(
  db: Shim,
  orgId: string,
  nowMs: number = Date.now()
): Promise<WarehouseIntelligence> {
  const today = todayManila(nowMs);
  const win = last30(nowMs); // trailing 30 days (inclusive), Asia/Manila

  const [productsRes, brandsRes, metricsRes, tiktokRes, levelsRes] = await Promise.all([
    db
      .from("products")
      .select(
        "id, org_id, brand_id, sku, product_name, category, is_fragile, is_perishable, is_high_value, unit_value, stocked_at, expiry_date, reorder_point, target_cover_days, status, notes, created_at, updated_at"
      )
      .eq("org_id", orgId)
      .order("product_name"),
    db.from("brands").select("id, name").eq("org_id", orgId).order("name"),
    db
      .from("product_metrics")
      .select("brand_id, sku, period_start, period_end, units, returns, product_rating, stock, created_at")
      .eq("org_id", orgId),
    db
      .from("tiktok_product_performance")
      .select("brand_id, sku, stat_date, units")
      .eq("org_id", orgId)
      .gte("stat_date", win.start)
      .lte("stat_date", win.end),
    // On-hand now lives in stock_levels (migration 0026). Keyed by product_id.
    db
      .from("stock_levels")
      .select("product_id, current_stock, reserved_stock, available_stock")
      .eq("org_id", orgId),
  ]);

  const products = (productsRes.data ?? []) as ProductRow[];
  const brands = (brandsRes.data ?? []) as BrandLite[];
  const metrics = (metricsRes.data ?? []) as MetricRow[];
  const tiktok = (tiktokRes.data ?? []) as TiktokRow[];
  const levels = (levelsRes.data ?? []) as {
    product_id: string;
    current_stock: number;
    reserved_stock: number;
    available_stock: number;
  }[];
  const levelByProduct = new Map(levels.map((l) => [l.product_id, l]));

  const brandName = new Map(brands.map((b) => [b.id, b.name]));

  // ── Aggregate signals per (brand, sku) ──────────────────────────────────────

  // Latest stock reading + latest rating, and trailing (period_end in window)
  // units/returns from product_metrics.
  type Agg = {
    stock: number | null;
    stockAt: string; // sort key for "latest" (period_end then created_at)
    rating: number | null;
    ratingAt: string;
    pmUnits: number; // trailing units from product_metrics
    pmHasSales: boolean; // any pm row with a units value in the window
    returns: number; // trailing returns
    hasReturns: boolean;
    tkUnits: number; // trailing units from tiktok daily rows
    tkHasRows: boolean; // any tiktok row in the window
  };
  const agg = new Map<string, Agg>();
  const blank = (): Agg => ({
    stock: null,
    stockAt: "",
    rating: null,
    ratingAt: "",
    pmUnits: 0,
    pmHasSales: false,
    returns: 0,
    hasReturns: false,
    tkUnits: 0,
    tkHasRows: false,
  });

  for (const m of metrics) {
    const k = key(m.brand_id, m.sku);
    const a = agg.get(k) ?? blank();
    // "Latest" reading by period_end, then created_at as a tiebreak.
    const sortAt = `${m.period_end ?? ""}|${m.created_at ?? ""}`;
    if (m.stock != null && sortAt >= a.stockAt) {
      a.stock = m.stock;
      a.stockAt = sortAt;
    }
    if (m.product_rating != null && sortAt >= a.ratingAt) {
      a.rating = Number(m.product_rating);
      a.ratingAt = sortAt;
    }
    // Trailing window attribution by period_end (the codebase convention).
    const inWindow = m.period_end != null && m.period_end >= win.start && m.period_end <= win.end;
    if (inWindow) {
      if (m.units != null) {
        a.pmUnits += m.units;
        a.pmHasSales = true;
      }
      if (m.returns != null) {
        a.returns += m.returns;
        a.hasReturns = true;
      }
    }
    agg.set(k, a);
  }

  for (const t of tiktok) {
    const k = key(t.brand_id, t.sku);
    const a = agg.get(k) ?? blank();
    a.tkHasRows = true;
    if (t.units != null) a.tkUnits += t.units;
    agg.set(k, a);
  }

  // ── Build one ProductIntel per product ──────────────────────────────────────

  const rows: ProductIntel[] = products.map((product) => {
    const a = agg.get(key(product.brand_id, product.sku)) ?? blank();

    // Trailing units: prefer TikTok daily rows (finer granularity, authoritative
    // for units sold) when any exist; otherwise fall back to product_metrics.
    // Preferring one source per SKU avoids double-counting the same sale.
    const units30d = a.tkHasRows ? a.tkUnits : a.pmUnits;
    const hasSalesData = a.tkHasRows || a.pmHasSales;

    // On-hand comes from the stock_levels home when a count exists; otherwise
    // fall back to any legacy product_metrics.stock reading (transition-safe),
    // else null (honest "no data").
    const level = levelByProduct.get(product.id) ?? null;
    const stock = level ? level.current_stock : a.stock;

    const velocity = computeVelocity({ stock, units30d, hasSalesData });

    const daysInStock = product.stocked_at ? Math.max(0, daysBetween(product.stocked_at, today)) : null;
    const daysToExpiry = product.expiry_date ? daysBetween(today, product.expiry_date) : null;
    const valueAtRisk =
      velocity.stock != null && product.unit_value != null
        ? velocity.stock * Number(product.unit_value)
        : null;
    const aging: AgingFacts = { daysInStock, daysToExpiry, valueAtRisk };

    const routable: RoutableProduct = {
      brand_id: product.brand_id,
      sku: product.sku,
      product_name: product.product_name,
      is_perishable: product.is_perishable,
      is_high_value: product.is_high_value,
      is_fragile: product.is_fragile,
      unit_value: product.unit_value,
      reorder_point: product.reorder_point,
      target_cover_days: product.target_cover_days,
    };

    return {
      product,
      brandName: product.brand_id ? brandName.get(product.brand_id) ?? null : null,
      velocity,
      aging,
      returns30d: a.hasReturns ? a.returns : null,
      productRating: a.rating,
      route: routeProduct(routable, velocity, aging),
      reserved: level ? level.reserved_stock : null,
      available: level ? level.available_stock : null,
    };
  });

  return { rows, brands, windowStart: win.start, windowEnd: win.end };
}
