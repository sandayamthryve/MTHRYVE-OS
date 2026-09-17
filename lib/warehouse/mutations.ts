// lib/warehouse/mutations.ts — the ONE place stock_levels / stock_movements are
// written. Keeping the level upsert and the ledger insert together here means
// current_stock and the movement ledger stay in lock-step through every flow,
// which is exactly what the discrepancy alert relies on.
//
// RLS gates the actual writes to the Warehouse team + leadership (migration
// 0026). Callers should also gate the UI with isWarehouseWriter so an
// unauthorised user never sees a control that would silently fail.

import { signedEffect, type MovementType, type StockLevelRow } from "./inventory";

type Shim = { from: (t: string) => any };

// Read the caller's existing stock_levels row for a product (or null).
async function readLevel(db: Shim, orgId: string, productId: string): Promise<StockLevelRow | null> {
  const res = await db
    .from("stock_levels")
    .select("id, product_id, brand_id, current_stock, reserved_stock, available_stock, damaged_stock, in_transit, reorder_level, updated_at")
    .eq("org_id", orgId)
    .eq("product_id", productId)
    .limit(1);
  return (res?.data?.[0] as StockLevelRow | undefined) ?? null;
}

// Upsert a stock_levels row, preserving fields the caller doesn't set. product_id
// is unique, so onConflict merges. org_id defaults at the DB but we stamp it so a
// service-role path is explicit.
async function upsertLevel(
  db: Shim,
  orgId: string,
  productId: string,
  brandId: string | null,
  patch: Record<string, unknown>
): Promise<void> {
  await db
    .from("stock_levels")
    .upsert(
      { org_id: orgId, product_id: productId, brand_id: brandId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "product_id" }
    );
}

export interface MovementArgs {
  orgId: string;
  productId: string;
  brandId: string | null;
  movementType: Exclude<MovementType, "manual_correction">;
  qty: number; // positive magnitude for directional types; signed for adjustment
  note?: string | null;
}

// Record a directional / adjustment movement: applies its signed effect to
// current_stock (floored at 0) AND logs the ledger row.
export async function recordMovement(db: Shim, args: MovementArgs): Promise<void> {
  const existing = await readLevel(db, args.orgId, args.productId);
  const oldCurrent = existing ? existing.current_stock : 0;
  const effect = signedEffect(args.movementType, args.qty);
  const newCurrent = Math.max(0, oldCurrent + effect);

  await upsertLevel(db, args.orgId, args.productId, args.brandId, { current_stock: newCurrent });
  await db.from("stock_movements").insert({
    org_id: args.orgId,
    product_id: args.productId,
    brand_id: args.brandId,
    movement_type: args.movementType,
    qty: args.qty,
    note: args.note ?? null,
  });
}

export interface RecountArgs {
  orgId: string;
  productId: string;
  brandId: string | null;
  countedStock: number; // the physically-counted absolute on-hand
  note?: string | null;
}

// Recount to an absolute on-hand value: sets current_stock and logs a
// manual_correction whose qty is the delta, so the ledger stays consistent.
export async function recountStock(db: Shim, args: RecountArgs): Promise<void> {
  const existing = await readLevel(db, args.orgId, args.productId);
  const oldCurrent = existing ? existing.current_stock : 0;
  const counted = Math.max(0, Math.round(args.countedStock));
  const delta = counted - oldCurrent;

  await upsertLevel(db, args.orgId, args.productId, args.brandId, { current_stock: counted });
  if (delta !== 0 || existing == null) {
    await db.from("stock_movements").insert({
      org_id: args.orgId,
      product_id: args.productId,
      brand_id: args.brandId,
      movement_type: "manual_correction",
      qty: delta,
      note: args.note ?? "Recount",
    });
  }
}

export interface LevelFieldArgs {
  orgId: string;
  productId: string;
  brandId: string | null;
  reserved?: number | null;
  damaged?: number | null;
  inTransit?: number | null;
  reorderLevel?: number | null;
}

// Set the non-ledger level fields (reserved / damaged / in-transit / reorder
// level). These aren't physical movements, so they don't touch the ledger —
// available_stock recomputes at the DB from current − reserved.
export async function updateLevelFields(db: Shim, args: LevelFieldArgs): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (args.reserved != null) patch.reserved_stock = Math.max(0, Math.round(args.reserved));
  if (args.damaged != null) patch.damaged_stock = Math.max(0, Math.round(args.damaged));
  if (args.inTransit != null) patch.in_transit = Math.max(0, Math.round(args.inTransit));
  if (args.reorderLevel !== undefined) {
    patch.reorder_level = args.reorderLevel == null ? null : Math.max(0, Math.round(args.reorderLevel));
  }
  if (Object.keys(patch).length === 0) return;
  await upsertLevel(db, args.orgId, args.productId, args.brandId, patch);
}
