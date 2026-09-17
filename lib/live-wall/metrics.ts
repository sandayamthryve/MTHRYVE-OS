// lib/live-wall/metrics.ts — per-session tile metrics, read straight off the
// live_sessions ROW.
//
// A live tile's headline numbers belong to the session itself, so they come
// directly from the session's own columns — NOT from metric_entries, which has
// no per-session grain (and no live.* rows), so a compartment lookup would leave
// every tile a permanent "—". This keeps each tile honest and self-contained.
//
// Honest nulls: a null column stays null → the tile renders "—", never a
// fabricated 0. Every field guards against an empty string / non-finite value.
// Pure functions only (no I/O), so this is trivially testable.

// The subset of live_sessions columns a tile reads. All nullable — an unrecorded
// metric is null, never 0.
export interface LiveSessionMetricRow {
  attributed_gmv: number | string | null;
  gmv: number | string | null;
  viewers: number | string | null;
  peak_viewers: number | string | null;
  avg_viewers: number | string | null;
  ctor: number | string | null;
  ctr: number | string | null;
  units_sold: number | string | null;
  orders: number | string | null;
  aov: number | string | null;
  conversion_rate: number | string | null;
}

// The comma-separated column list to select for the tile metrics (kept next to
// the shape so the query and the reader never drift).
export const TILE_METRIC_COLUMNS =
  "attributed_gmv, gmv, viewers, peak_viewers, avg_viewers, ctor, ctr, units_sold, orders, aov, conversion_rate";

export interface TileMetrics {
  gmv: number | null; // attributed GMV, else raw GMV
  viewers: number | null; // live viewers, else peak, else average
  ctor: number | null; // click-to-order rate (percent)
  ctr: number | null; // click-through rate (percent)
  unitsSold: number | null;
  orders: number | null;
  aov: number | null; // average order value (PHP)
  conversionRate: number | null; // percent
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The first non-null of a set of candidates (honest fallback chain), else null.
function firstOf(...vals: (number | string | null | undefined)[]): number | null {
  for (const v of vals) {
    const n = num(v);
    if (n != null) return n;
  }
  return null;
}

// Derive a tile's metrics from its live_sessions row. GMV prefers the attributed
// figure; viewers prefer the live count then peak then average; the rest map 1:1.
export function tileMetricsFromRow(row: LiveSessionMetricRow): TileMetrics {
  return {
    gmv: firstOf(row.attributed_gmv, row.gmv),
    viewers: firstOf(row.viewers, row.peak_viewers, row.avg_viewers),
    ctor: num(row.ctor),
    ctr: num(row.ctr),
    unitsSold: num(row.units_sold),
    orders: num(row.orders),
    aov: num(row.aov),
    conversionRate: num(row.conversion_rate),
  };
}
