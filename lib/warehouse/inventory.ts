// lib/warehouse/inventory.ts — the SINGLE server-side data layer for the
// Warehouse module's own domain facts: stock_levels (on-hand / reserved /
// available / damaged / in-transit), stock_movements (the append-only ledger)
// and the product master. Every Warehouse surface — the Overview dashboard, the
// Stock module, and the level columns on Product Intelligence — reads through
// loadInventory here, so a SKU's available count, restocking requirement,
// movement class and alerts are computed in exactly ONE place and can never
// disagree between views.
//
// ONE HOME PER FACT: on-hand quantities live in stock_levels; movements live in
// stock_movements; the dashboard KPIs DERIVE from those at read time — nothing
// is re-encoded into product_metrics or metric_entries. Honest nulls: a product
// with no stock_levels row has current/available = null and renders "—", never 0.
//
// The provisioned tables aren't in the generated Database types, so callers pass
// the same loose cast shim the rest of the warehouse code uses.

import { FAST_COVER_DAYS, SLOW_COVER_DAYS, type MovementClass } from "./velocity";

export type Shim = { from: (t: string) => any };

// ── Row shapes ────────────────────────────────────────────────────────────────

// The full product master row (base columns + the 0026 additive columns).
export interface ProductMaster {
  id: string;
  org_id: string;
  brand_id: string | null;
  sku: string;
  product_name: string | null;
  category: string | null;
  status: string;
  reorder_point: number | null;
  // 0026 additive columns
  variant: string | null;
  barcode: string | null;
  warehouse_location: string | null;
  cost: number | null;
  selling_price: number | null;
  // reused catalogue columns
  unit_value: number | null;
  is_fragile: boolean;
  is_perishable: boolean;
  is_high_value: boolean;
  stocked_at: string | null;
  expiry_date: string | null;
  target_cover_days: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const PRODUCT_COLUMNS =
  "id, org_id, brand_id, sku, product_name, category, status, reorder_point, variant, barcode, warehouse_location, cost, selling_price, unit_value, is_fragile, is_perishable, is_high_value, stocked_at, expiry_date, target_cover_days, notes, created_at, updated_at";

export interface StockLevelRow {
  id: string;
  product_id: string;
  brand_id: string | null;
  current_stock: number;
  reserved_stock: number;
  available_stock: number; // generated: greatest(current - reserved, 0)
  damaged_stock: number;
  in_transit: number;
  reorder_level: number | null;
  updated_at: string;
}

export const STOCK_LEVEL_COLUMNS =
  "id, product_id, brand_id, current_stock, reserved_stock, available_stock, damaged_stock, in_transit, reorder_level, updated_at";

export type MovementType =
  | "stock_in"
  | "stock_out"
  | "adjustment"
  | "manual_correction"
  | "return"
  | "transfer";

export interface StockMovementRow {
  id: string;
  product_id: string;
  brand_id: string | null;
  movement_type: MovementType;
  qty: number;
  note: string | null;
  personnel_id: string | null;
  created_at: string;
}

export const MOVEMENT_COLUMNS =
  "id, product_id, brand_id, movement_type, qty, note, personnel_id, created_at";

export interface ProductHistoryRow {
  id: string;
  product_id: string;
  user_id: string | null;
  changed_at: string;
  changes: Record<string, { old: unknown; new: unknown }>;
}

export interface BrandLite {
  id: string;
  name: string;
}

// ── Movement vocabulary ───────────────────────────────────────────────────────
// Each movement type's display label and its SIGNED effect on current_stock.
// qty is stored as the user-entered magnitude for the directional types and as a
// signed delta for adjustment / manual_correction, so the ledger net (sum of
// signedEffect) tracks current_stock through every normal flow — the basis of
// the discrepancy alert.

export const MOVEMENT_TYPES: { value: MovementType; label: string; dir: 1 | -1; note: string }[] = [
  { value: "stock_in", label: "Stock In", dir: 1, note: "Received into the warehouse" },
  { value: "stock_out", label: "Stock Out", dir: -1, note: "Shipped / consumed" },
  { value: "return", label: "Return", dir: 1, note: "Returned to sellable stock" },
  { value: "transfer", label: "Transfer", dir: -1, note: "Transferred out" },
  { value: "adjustment", label: "Adjustment", dir: 1, note: "Signed correction (± qty)" },
  { value: "manual_correction", label: "Manual Correction", dir: 1, note: "Recount to an absolute value" },
];

export const MOVEMENT_LABEL: Record<MovementType, string> = MOVEMENT_TYPES.reduce(
  (m, t) => ({ ...m, [t.value]: t.label }),
  {} as Record<MovementType, string>
);

// The signed contribution a stored movement row makes to current_stock. qty for
// stock_out / transfer is a positive magnitude flipped negative here; adjustment
// and manual_correction store an already-signed delta.
export function signedEffect(type: MovementType, qty: number): number {
  switch (type) {
    case "stock_in":
    case "return":
      return qty;
    case "stock_out":
    case "transfer":
      return -qty;
    case "adjustment":
    case "manual_correction":
      return qty;
  }
}

// ── Derived per-product intelligence ──────────────────────────────────────────

export interface InventoryRow {
  product: ProductMaster;
  brandName: string | null;
  level: StockLevelRow | null;

  // On-hand facts (null when there is no stock_levels row → honest "—").
  current: number | null;
  reserved: number | null;
  available: number | null;
  damaged: number | null;
  inTransit: number | null;
  reorderLevel: number | null;

  // reorder_level − available, floored at 0. null when either input is unknown.
  restockRequirement: number | null;

  // Movement over the period (from stock_movements outbound qty).
  outUnits: number; // stock_out + transfer qty in window
  inUnits: number; // stock_in + return qty in window
  movement: MovementClass; // fast / healthy / slow / nonmoving(dead) / unknown
  avgDailyOut: number;
  daysOfCover: number | null;

  // Ledger integrity.
  ledgerNet: number; // sum of signedEffect over ALL movements
  discrepancy: boolean; // level exists AND ledgerNet != current_stock

  lastMovementAt: string | null;
  lastUpdatedAt: string | null; // stock_levels.updated_at

  // Operational alerts.
  low: boolean; // available <= reorder_level (both known)
  zero: boolean; // available == 0 (level exists)
}

// Classify movement from outbound velocity over an arbitrary window. Mirrors the
// velocity engine's cover-day thresholds but window-aware, and treats zero
// outbound with stock on hand as the dead-moving signal.
function classifyByOut(
  current: number | null,
  outUnits: number,
  windowDays: number
): { movement: MovementClass; avgDailyOut: number; daysOfCover: number | null } {
  const days = windowDays > 0 ? windowDays : 30;
  const avgDailyOut = outUnits > 0 ? outUnits / days : 0;
  if (current == null) return { movement: "unknown", avgDailyOut, daysOfCover: null };
  if (outUnits <= 0) {
    return { movement: current > 0 ? "nonmoving" : "unknown", avgDailyOut, daysOfCover: null };
  }
  const cover = avgDailyOut > 0 ? current / avgDailyOut : null;
  if (cover == null) return { movement: "unknown", avgDailyOut, daysOfCover: null };
  const movement: MovementClass =
    cover < FAST_COVER_DAYS ? "fast" : cover > SLOW_COVER_DAYS ? "slow" : "healthy";
  return { movement, avgDailyOut, daysOfCover: cover };
}

export interface LoadedInventory {
  rows: InventoryRow[];
  brands: BrandLite[];
  movements: StockMovementRow[]; // ALL movements for the org, newest first
  windowStart: string;
  windowEnd: string;
  windowDays: number;
}

// Whole days between two YYYY-MM-DD dates, inclusive count (end − start + 1).
function inclusiveDays(start: string, end: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const a = Date.UTC(sy, sm - 1, sd);
  const b = Date.UTC(ey, em - 1, ed);
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

// A YYYY-MM-DD date from a timestamptz string, in Asia/Manila. Movements are
// attributed to the window by their created_at calendar day.
function manilaDay(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 10);
  }
}

// Load + derive the full inventory picture for an org over [windowStart, windowEnd]
// (inclusive YYYY-MM-DD, Asia/Manila). The window scopes the movement-derived
// figures (incoming/outgoing/movement class); levels and the ledger net are
// point-in-time / all-time and unaffected by the window.
export async function loadInventory(
  db: Shim,
  orgId: string,
  windowStart: string,
  windowEnd: string
): Promise<LoadedInventory> {
  const [productsRes, brandsRes, levelsRes, movesRes] = await Promise.all([
    db.from("products").select(PRODUCT_COLUMNS).eq("org_id", orgId).order("product_name"),
    db.from("brands").select("id, name").eq("org_id", orgId).order("name"),
    db.from("stock_levels").select(STOCK_LEVEL_COLUMNS).eq("org_id", orgId),
    db
      .from("stock_movements")
      .select(MOVEMENT_COLUMNS)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false }),
  ]);

  const products = (productsRes.data ?? []) as ProductMaster[];
  const brands = (brandsRes.data ?? []) as BrandLite[];
  const levels = (levelsRes.data ?? []) as StockLevelRow[];
  const movements = (movesRes.data ?? []) as StockMovementRow[];

  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const levelByProduct = new Map(levels.map((l) => [l.product_id, l]));

  const windowDays = inclusiveDays(windowStart, windowEnd);

  // Per-product movement aggregates: all-time ledger net + last movement, plus
  // in-window inbound / outbound magnitudes.
  type Agg = { net: number; lastAt: string | null; inW: number; outW: number };
  const agg = new Map<string, Agg>();
  for (const m of movements) {
    const a = agg.get(m.product_id) ?? { net: 0, lastAt: null, inW: 0, outW: 0 };
    a.net += signedEffect(m.movement_type, m.qty);
    if (a.lastAt == null || m.created_at > a.lastAt) a.lastAt = m.created_at;
    const day = manilaDay(m.created_at);
    if (day >= windowStart && day <= windowEnd) {
      if (m.movement_type === "stock_in" || m.movement_type === "return") a.inW += m.qty;
      if (m.movement_type === "stock_out" || m.movement_type === "transfer") a.outW += m.qty;
    }
    agg.set(m.product_id, a);
  }

  const rows: InventoryRow[] = products.map((product) => {
    const level = levelByProduct.get(product.id) ?? null;
    const a = agg.get(product.id) ?? { net: 0, lastAt: null, inW: 0, outW: 0 };

    const current = level ? level.current_stock : null;
    const available = level ? level.available_stock : null;
    const reorderLevel = level ? level.reorder_level : null;

    const restockRequirement =
      reorderLevel != null && available != null ? Math.max(0, reorderLevel - available) : null;

    const { movement, avgDailyOut, daysOfCover } = classifyByOut(current, a.outW, windowDays);

    const discrepancy = level != null && a.net !== level.current_stock;
    const low = available != null && reorderLevel != null && available <= reorderLevel;
    const zero = level != null && available === 0;

    return {
      product,
      brandName: product.brand_id ? brandName.get(product.brand_id) ?? null : null,
      level,
      current,
      reserved: level ? level.reserved_stock : null,
      available,
      damaged: level ? level.damaged_stock : null,
      inTransit: level ? level.in_transit : null,
      reorderLevel,
      restockRequirement,
      outUnits: a.outW,
      inUnits: a.inW,
      movement,
      avgDailyOut,
      daysOfCover,
      ledgerNet: a.net,
      discrepancy,
      lastMovementAt: a.lastAt,
      lastUpdatedAt: level ? level.updated_at : null,
      low,
      zero,
    };
  });

  return { rows, brands, movements, windowStart, windowEnd, windowDays };
}

// ── Org-level KPIs (derived; honest nulls) ────────────────────────────────────

export interface InventoryKpis {
  activeBrands: number; // distinct brands among active products that carry a brand
  activeSkus: number; // products with status 'active'
  availableStocks: number | null; // sum available_stock; null when NO product has a level
  lowStock: number; // available <= reorder_level
  outOfStock: number; // available == 0 (has a level row)
  countedSkus: number; // products with a stock_levels row
  discrepancies: number; // ledger net != current_stock
}

export function computeInventoryKpis(rows: InventoryRow[]): InventoryKpis {
  const active = rows.filter((r) => r.product.status === "active");
  const brandSet = new Set<string>();
  for (const r of active) if (r.product.brand_id) brandSet.add(r.product.brand_id);

  const withLevel = rows.filter((r) => r.level != null);
  const availableStocks =
    withLevel.length === 0
      ? null
      : withLevel.reduce((sum, r) => sum + (r.available ?? 0), 0);

  return {
    activeBrands: brandSet.size,
    activeSkus: active.length,
    availableStocks,
    lowStock: rows.filter((r) => r.low).length,
    outOfStock: rows.filter((r) => r.zero).length,
    countedSkus: withLevel.length,
    discrepancies: rows.filter((r) => r.discrepancy).length,
  };
}

// Sum of a movement type's qty across a list (already window-filtered by caller).
export function sumByType(movements: StockMovementRow[], types: MovementType[]): number {
  const set = new Set(types);
  return movements.reduce((s, m) => (set.has(m.movement_type) ? s + m.qty : s), 0);
}

// Filter movements to a window by their Asia/Manila calendar day (inclusive).
export function movementsInWindow(
  movements: StockMovementRow[],
  start: string,
  end: string
): StockMovementRow[] {
  return movements.filter((m) => {
    const d = manilaDay(m.created_at);
    return d >= start && d <= end;
  });
}

// Enumerate the inclusive list of YYYY-MM-DD days from start to end.
function enumerateDays(start: string, end: string): string[] {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  let cur = Date.UTC(sy, sm - 1, sd);
  const last = Date.UTC(ey, em - 1, ed);
  const out: string[] = [];
  let guard = 0;
  while (cur <= last && guard < 400) {
    const d = new Date(cur);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
    cur += 86_400_000;
    guard++;
  }
  return out;
}

export interface DayMovement {
  day: string;
  inUnits: number; // stock_in + return
  outUnits: number; // stock_out + transfer
  net: number; // signed net across all types
}

// A per-day inbound / outbound / net movement series over [start, end] — drives
// the Inventory Trend and Stock Consumption Rate charts. Days with no movement
// are present with zeros so the axis is continuous.
export function dailyMovementSeries(
  movements: StockMovementRow[],
  start: string,
  end: string
): DayMovement[] {
  const days = enumerateDays(start, end);
  const byDay = new Map<string, DayMovement>(days.map((d) => [d, { day: d, inUnits: 0, outUnits: 0, net: 0 }]));
  for (const m of movements) {
    const d = manilaDay(m.created_at);
    const slot = byDay.get(d);
    if (!slot) continue;
    if (m.movement_type === "stock_in" || m.movement_type === "return") slot.inUnits += m.qty;
    if (m.movement_type === "stock_out" || m.movement_type === "transfer") slot.outUnits += m.qty;
    slot.net += signedEffect(m.movement_type, m.qty);
  }
  return days.map((d) => byDay.get(d)!);
}

// Top-N products by outbound units over the period (Product Performance Ranking).
export function topByOutbound(rows: InventoryRow[], n: number): InventoryRow[] {
  return [...rows]
    .filter((r) => r.outUnits > 0)
    .sort((a, b) => b.outUnits - a.outUnits)
    .slice(0, n);
}
