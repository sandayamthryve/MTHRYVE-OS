// lib/warehouse/velocity.ts — the SINGLE product-velocity engine for the
// Intelligent Warehouse. Pure math, no DB. Per (brand_id, sku) it turns a stock
// reading + trailing sales into days-of-cover and a movement class. The
// Product Intelligence view, the replenish action path and the push-to-sell
// action path ALL run through this one module — the movement/cover numbers on a
// card and in a drafted action are computed here and nowhere else, so they can
// never disagree.
//
// Honest states: a null stock reading (no product_metrics row) yields movement
// 'unknown', never a fabricated class. Days-of-cover is null (not Infinity/0)
// when there are no trailing sales to divide by — the "not set" state the UI
// renders as an em-dash.

// The trailing sales window is 30 calendar days (Asia/Manila; the caller resolves
// the window and passes the summed units in).
export const VELOCITY_WINDOW_DAYS = 30;

// Movement-class thresholds (task spec):
//   Fast     = days_of_cover < 21
//   Healthy  = 21 ≤ days_of_cover ≤ 60
//   Slow     = selling but days_of_cover > 60
//   Non-moving = stock > 0 AND 0 units sold in the window
export const FAST_COVER_DAYS = 21;
export const SLOW_COVER_DAYS = 60;

// Replenish trigger when no reorder_point is set: days_of_cover below one week.
export const REPLENISH_COVER_DAYS = 7;

export type MovementClass = "fast" | "healthy" | "slow" | "nonmoving" | "unknown";

// The per-SKU inputs the data layer aggregates from product_metrics /
// tiktok_product_performance and hands to the engine.
export interface VelocityInput {
  // Latest stock reading (product_metrics.stock). null = no reading at all.
  stock: number | null;
  // Units sold across the trailing window (0 when there are sales rows but no
  // units, or no sales rows at all — hasSalesData disambiguates the two).
  units30d: number;
  // Whether ANY trailing sales row existed for this SKU in the window. Lets the
  // engine tell "sold zero" (a real non-moving signal) from "no sales data".
  hasSalesData: boolean;
}

export interface Velocity {
  stock: number | null;
  units30d: number;
  avgDailyUnits: number; // units30d / window; 0 when no units
  daysOfCover: number | null; // stock / avgDailyUnits; null when it can't be divided
  movement: MovementClass;
  hasStockData: boolean;
  hasSalesData: boolean;
}

// Average daily units over the window. 0 when nothing sold — never NaN.
export function averageDailyUnits(units30d: number): number {
  const u = Number.isFinite(units30d) && units30d > 0 ? units30d : 0;
  return u / VELOCITY_WINDOW_DAYS;
}

// Days of cover = stock ÷ avg daily units. Guarded: null when there's no stock
// reading or no sales to divide by (the honest "can't compute" state), so the
// caller never shows Infinity or a divide-by-zero 0.
export function daysOfCover(stock: number | null, avgDailyUnits: number): number | null {
  if (stock == null) return null;
  if (!(avgDailyUnits > 0)) return null;
  return stock / avgDailyUnits;
}

// The movement class from the raw signals. Kept separate so it reads exactly
// like the spec and can be unit-reasoned in isolation.
export function classifyMovement(
  stock: number | null,
  units30d: number,
  cover: number | null
): MovementClass {
  // No stock reading → we can't honestly place it on the fast↔slow axis.
  if (stock == null) return "unknown";

  // Nothing sold in the window.
  if (units30d <= 0) {
    // Sitting stock that sold zero is the classic non-moving signal.
    if (stock > 0) return "nonmoving";
    // No stock AND no sales — nothing to act on and no demand signal to call it
    // "healthy". The honest state is "no data", so it never becomes replenish- or
    // push-eligible off a contradictory zero/zero reading.
    return "unknown";
  }

  // Selling. Sold-out fast movers (stock 0, cover 0) fall through as 'fast'.
  if (cover == null) return "unknown"; // defensive; unreachable when units>0 & stock known
  if (cover < FAST_COVER_DAYS) return "fast";
  if (cover > SLOW_COVER_DAYS) return "slow";
  return "healthy";
}

// The one entry point. Turns the aggregated inputs into the full Velocity used
// everywhere (view + both action paths).
export function computeVelocity(input: VelocityInput): Velocity {
  const stock = input.stock;
  const units30d = Number.isFinite(input.units30d) && input.units30d > 0 ? Math.round(input.units30d) : 0;
  const avgDailyUnits = averageDailyUnits(units30d);
  const cover = daysOfCover(stock, avgDailyUnits);
  const movement = classifyMovement(stock, units30d, cover);
  return {
    stock,
    units30d,
    avgDailyUnits,
    daysOfCover: cover,
    movement,
    hasStockData: stock != null,
    hasSalesData: input.hasSalesData,
  };
}

// ── Movement presentation ─────────────────────────────────────────────────────

export const MOVEMENT_LABEL: Record<MovementClass, string> = {
  fast: "Fast",
  healthy: "Healthy",
  slow: "Slow",
  nonmoving: "Non-moving",
  unknown: "No data",
};

// Tones mirror the app's badge vocabulary: fast = teal (good throughput),
// healthy = violet (informational/steady), slow = amber (watch), non-moving =
// red (dead stock / risk), unknown = muted (no data).
export type MovementTone = "teal" | "violet" | "amber" | "red" | "muted";

export function movementTone(m: MovementClass): MovementTone {
  switch (m) {
    case "fast":
      return "teal";
    case "healthy":
      return "violet";
    case "slow":
      return "amber";
    case "nonmoving":
      return "red";
    default:
      return "muted";
  }
}
