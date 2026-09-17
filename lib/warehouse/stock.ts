// lib/warehouse/stock.ts — stock-on-hand helpers for the Intelligent Warehouse.
//
// Two things live here:
//   1. The pure predicates the Stock view highlights on — LOW-STOCK and EXPIRING —
//      kept as tiny functions so the view (and any future scan) share one
//      definition and can never drift.
//   2. setManualStock — the ONE place a human-entered stock count is persisted.
//
// WHERE STOCK LIVES (no schema change): the products table has no quantity
// column — the OS already reads stock-on-hand from product_metrics.stock (the
// velocity engine, the Product Intelligence view and the replenish/push loop all
// key off it). So a manually-entered count lands as a product_metrics row tagged
// origin='manual', with units left null so it contributes a stock reading WITHOUT
// fabricating any sales. Exactly one manual row is kept per (org, brand, sku) —
// re-entering a count updates it in place rather than piling up snapshots. Once a
// real count exists the existing loop scans it with no changes on its side.

// LOW-STOCK: an on-hand count at or below the reorder point. Both must be known —
// a missing count or an unset reorder point is "unknown", never "low".
export function isLowStock(stock: number | null, reorderPoint: number | null): boolean {
  return stock != null && reorderPoint != null && stock <= reorderPoint;
}

// EXPIRING: a perishable's expiry falls within its target cover window — i.e. it
// will (or already did) expire before the cover it's meant to last runs out.
// Already-expired stock (negative days) is included; it's the most urgent case.
export function isExpiring(daysToExpiry: number | null, targetCoverDays: number): boolean {
  return daysToExpiry != null && daysToExpiry <= targetCoverDays;
}

// The tags that mark a product_metrics row as a manual stock snapshot.
export const MANUAL_STOCK_ORIGIN = "manual";
export const MANUAL_STOCK_PLATFORM = "manual";

// product_metrics isn't in the generated Database types, so writes go through this
// loose shim (the same cast the rest of the warehouse code uses).
type WriteShim = { from: (t: string) => any };

export interface ManualStockArgs {
  orgId: string;
  brandId: string | null;
  sku: string;
  productName: string | null;
  stock: number; // non-negative on-hand count
  today: string; // YYYY-MM-DD (Asia/Manila) — the snapshot's period
}

// Upsert the single manual stock snapshot for one (org, brand, sku). RLS scopes
// product_metrics writes to leadership (ceo/coo/department_head) — callers must
// already have gated on that; this helper does not re-check.
export async function setManualStock(db: WriteShim, args: ManualStockArgs): Promise<void> {
  // Find an existing manual snapshot for this exact product (brand may be null).
  let find = db
    .from("product_metrics")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("origin", MANUAL_STOCK_ORIGIN)
    .eq("sku", args.sku);
  find = args.brandId == null ? find.is("brand_id", null) : find.eq("brand_id", args.brandId);
  const existing = await find.limit(1);
  const existingId: string | undefined = existing?.data?.[0]?.id;

  const shared = {
    product_name: args.productName,
    stock: args.stock,
    period_start: args.today,
    period_end: args.today,
  };

  if (existingId) {
    await db
      .from("product_metrics")
      .update(shared)
      .eq("id", existingId)
      .eq("org_id", args.orgId);
    return;
  }

  await db.from("product_metrics").insert({
    org_id: args.orgId,
    brand_id: args.brandId,
    platform: MANUAL_STOCK_PLATFORM,
    origin: MANUAL_STOCK_ORIGIN,
    sku: args.sku,
    units: null, // a stock reading only — never a fabricated sale
    ...shared,
  });
}
