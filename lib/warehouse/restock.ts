// lib/warehouse/restock.ts — Warehouse intake → product sync.
//
// When a return case lands in the "restocked" status the returned units are
// physically back in sellable stock, so they must flow into the SAME on-hand
// picture every Warehouse surface already reads (stock_levels + stock_movements
// through lib/warehouse/mutations). This is the ONE place that translation
// happens, reused by the Returns tracker's create and triage actions so the two
// never drift and a returned unit is only ever counted back in once.
//
// Idempotent by construction: each sync writes a single `return` movement whose
// note carries a stable [rc:<caseId>] marker, and a case that already has such a
// movement is never restocked again. That makes re-saving a restocked case safe,
// and lets a Warehouse writer recover a sync that a non-writer's earlier save
// left undone (RLS on stock_* silently no-ops a non-writer's ledger write) — the
// marker is absent, so the retry lands.
//
// Matched by SKU against the product master (case-insensitive), preferring a
// brand match when the case names a brand — mirroring the CSV import's matching.
// When the SKU resolves to no product the sync skips rather than inventing one;
// the return case still advances to restocked.

import { recordMovement } from "./mutations";
import type { Shim } from "./inventory";

export type RestockSyncResult =
  | "synced"
  | "already"
  | "skipped_no_sku"
  | "skipped_no_product";

export interface RestockSyncArgs {
  orgId: string;
  caseId: string;
  sku: string | null;
  brandId: string | null;
  units: number | null;
  reference?: string | null; // human-readable order/case ref for the ledger note
}

// The stable per-case marker embedded in the movement note. A return case can
// only be restocked into stock once; this string is how the ledger is recognised
// as already carrying that restock without a foreign key from stock_movements
// back to return_cases. The uuid contains no LIKE wildcards, so it is safe to
// match with ilike.
export function restockMarker(caseId: string): string {
  return `[rc:${caseId}]`;
}

export async function syncRestockFromReturn(
  db: Shim,
  args: RestockSyncArgs
): Promise<RestockSyncResult> {
  const sku = (args.sku ?? "").trim();
  if (!sku) return "skipped_no_sku";

  const marker = restockMarker(args.caseId);

  // Idempotency: has this exact case already been restocked into the ledger?
  const prior = await db
    .from("stock_movements")
    .select("id")
    .eq("org_id", args.orgId)
    .eq("movement_type", "return")
    .ilike("note", `%${marker}%`)
    .limit(1);
  if (((prior?.data as { id: string }[] | null) ?? []).length > 0) return "already";

  // Resolve the SKU against the product master. Reads all org products and
  // matches in JS (as the CSV import does) so a stray %/_ in a SKU can't turn
  // into a LIKE wildcard, and a brand-scoped duplicate SKU resolves to the row
  // for the case's brand.
  const prodRes = await db.from("products").select("id, brand_id, sku").eq("org_id", args.orgId);
  const rows = (prodRes?.data as { id: string; brand_id: string | null; sku: string }[] | null) ?? [];
  const target = sku.toLowerCase();
  const matches = rows.filter((p) => (p.sku ?? "").trim().toLowerCase() === target);
  if (matches.length === 0) return "skipped_no_product";
  const product = (args.brandId && matches.find((p) => p.brand_id === args.brandId)) || matches[0];

  const units = Math.max(1, Math.round(args.units ?? 1));
  const refPart = args.reference ? ` ${args.reference.trim()}` : "";
  await recordMovement(db, {
    orgId: args.orgId,
    productId: product.id,
    brandId: product.brand_id,
    movementType: "return",
    qty: units,
    note: `Restocked from return${refPart} ${marker}`.replace(/\s+/g, " ").trim(),
  });
  return "synced";
}
