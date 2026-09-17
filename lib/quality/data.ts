// lib/quality/data.ts — the SHARED data layer for the Returns/Quality loop.
//
// One reader that pulls per-brand commerce facts (from the live
// tiktok_shop_performance set via lib/metrics/gmv, NOT the retired
// brand_platform_metrics) for the trailing window AND the prior window, plus
// per-SKU quality facts
// (product_metrics) for the trailing window, scoped to the caller's org, and
// shapes them into the BrandQualityFacts / ProductQualityFacts the pure signal
// engine (lib/quality/signal.ts) routes on. The "Scan quality" producer calls
// this, so the numbers Tony flags are computed in exactly one place.
//
// Windows are trailing 7-day spans resolved in Asia/Manila (lib/metrics/windows).
// The prior window is the immediately-preceding 7 days, so "this week vs last" is
// a clean, disjoint comparison.
//
// REAL DATA, HONEST NULLS. A brand/SKU with no rows in the window contributes
// nothing. return_rate is read from the reported column (orders-weighted) because
// the fact table carries return_rate directly and often leaves the raw returns
// count null — recomputing returns/orders would fabricate a zero rate where the
// platform actually reported a real one. When raw returns ARE present they win
// (a true count beats a reported ratio). Divide-by-zero anywhere yields null.
//
// The provisioned metrics tables aren't in the generated Database types, so — like
// the Warehouse and Finance modules — reads go through this cast shim.

import { last7, currentIsoWeekManila } from "@/lib/metrics/windows";
import { fetchCommerceRows } from "@/lib/metrics/gmv";
import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { BrandQualityFacts, ProductQualityFacts } from "./signal";

type Shim = { from: (t: string) => any };

const DAY_MS = 24 * 60 * 60 * 1000;

export interface QualitySignals {
  brands: BrandQualityFacts[]; // one per brand with any rows in the window
  products: ProductQualityFacts[]; // one per SKU with any rows in the window
  window: { start: string; end: string };
  priorWindow: { start: string; end: string };
  isoWeek: string;
}

const num = (v: number | null | undefined): number => (v == null ? 0 : Number(v));

type BpmRow = {
  brand_id: string;
  period_start: string | null;
  period_end: string | null;
  gmv: number | null;
  orders: number | null;
  units: number | null;
  returns: number | null;
  return_rate: number | null;
  fulfillment_errors: number | null;
};

// A per-brand aggregate for one window, computed from the raw fact rows whose
// period_end falls in [start, end] (the codebase's window-attribution convention).
interface BrandAgg {
  orders: number;
  units: number;
  gmv: number;
  returns: number;
  hasReturns: boolean;
  fulfillmentErrors: number;
  hasFulfillmentErrors: boolean;
  returnRate: number | null;
}

function aggregateBrand(rows: BpmRow[], start: string, end: string): BrandAgg {
  let orders = 0;
  let units = 0;
  let gmv = 0;
  let returns = 0;
  let hasReturns = false;
  let fe = 0;
  let hasFe = false;
  // Orders-weighted reported return_rate (primary), and a simple mean fallback for
  // rows that report a rate but no orders to weight by.
  let rrNumer = 0;
  let rrDenom = 0;
  let rrSum = 0;
  let rrN = 0;

  for (const r of rows) {
    if (r.period_end == null || r.period_end < start || r.period_end > end) continue;
    const rowOrders = num(r.orders);
    orders += rowOrders;
    units += num(r.units);
    gmv += num(r.gmv);
    if (r.returns != null) {
      returns += Number(r.returns);
      hasReturns = true;
    }
    if (r.fulfillment_errors != null) {
      fe += Number(r.fulfillment_errors);
      hasFe = true;
    }
    if (r.return_rate != null) {
      const rate = Number(r.return_rate);
      rrSum += rate;
      rrN += 1;
      if (rowOrders > 0) {
        rrNumer += rate * rowOrders;
        rrDenom += rowOrders;
      }
    }
  }

  // Prefer a true count (returns/orders) when returns are reported; else the
  // orders-weighted reported rate; else a simple mean of reported rates; else null.
  const returnRate =
    hasReturns && orders > 0
      ? returns / orders
      : rrDenom > 0
        ? rrNumer / rrDenom
        : rrN > 0
          ? rrSum / rrN
          : null;

  return {
    orders,
    units,
    gmv,
    returns,
    hasReturns,
    fulfillmentErrors: fe,
    hasFulfillmentErrors: hasFe,
    returnRate,
  };
}

type PmRow = {
  brand_id: string | null;
  sku: string | null;
  product_name: string | null;
  period_start: string | null;
  period_end: string | null;
  units: number | null;
  returns: number | null;
  product_rating: number | null;
  created_at: string | null;
};

// A stable per-SKU key: brand_id + case-folded sku (a SKU is matched within its
// own brand; null-brand SKUs group with null-brand rows).
function skuKey(brandId: string | null, sku: string | null): string {
  return `${brandId ?? ""}::${(sku ?? "").trim().toLowerCase()}`;
}

// Load the full quality signal set for the caller's org.
export async function loadQualitySignals(
  db: Shim,
  orgId: string,
  nowMs: number = Date.now()
): Promise<QualitySignals> {
  const win = last7(nowMs); // trailing 7 days ending today (Asia/Manila)
  const prior = last7(nowMs - 7 * DAY_MS); // the immediately-preceding 7 days
  const isoWeek = currentIsoWeekManila(nowMs).isoWeek;

  const [brandsRes, bpmRows, pmRes] = await Promise.all([
    db.from("brands").select("id, name").eq("org_id", orgId),
    // Commerce facts from the LIVE tiktok_shop_performance set (org-scoped) — never
    // the retired brand_platform_metrics. It carries no returns/fulfillment columns,
    // so returnRate / returns / fulfillmentErrors resolve to honest nulls below (the
    // quality signal already renders those as "—", never a fabricated 0).
    fetchCommerceRows(
      db as unknown as ReturnType<typeof createServerSupabaseClient>,
      { orgId }
    ) as unknown as Promise<BpmRow[]>,
    db
      .from("product_metrics")
      .select("brand_id, sku, product_name, period_start, period_end, units, returns, product_rating, created_at")
      .eq("org_id", orgId)
      .gte("period_end", win.start)
      .lte("period_end", win.end),
  ]);

  const brandName = new Map<string, string>();
  for (const b of (brandsRes.data ?? []) as Array<{ id: string; name: string }>) {
    brandName.set(b.id, b.name);
  }

  // ── Brand facts ──────────────────────────────────────────────────────────────
  const byBrand = new Map<string, BpmRow[]>();
  for (const r of bpmRows) {
    if (!r.brand_id) continue;
    const arr = byBrand.get(r.brand_id);
    if (arr) arr.push(r);
    else byBrand.set(r.brand_id, [r]);
  }

  const brands: BrandQualityFacts[] = [];
  for (const [brandId, rows] of byBrand) {
    const cur = aggregateBrand(rows, win.start, win.end);
    // A brand with no rows attributed to the current window carries no signal.
    if (cur.orders === 0 && cur.units === 0 && cur.returnRate == null && !cur.hasFulfillmentErrors) {
      continue;
    }
    const prev = aggregateBrand(rows, prior.start, prior.end);
    brands.push({
      brandId,
      brandName: brandName.get(brandId) ?? null,
      returnRate: cur.returnRate,
      priorReturnRate: prev.returnRate,
      returns: cur.hasReturns ? cur.returns : null,
      units: cur.units,
      orders: cur.orders,
      gmv: cur.gmv,
      fulfillmentErrors: cur.hasFulfillmentErrors ? cur.fulfillmentErrors : null,
    });
  }

  // ── Product facts ─────────────────────────────────────────────────────────────
  const pmRows = (pmRes.data ?? []) as PmRow[];
  type PAgg = {
    brandId: string | null;
    sku: string;
    productName: string | null;
    nameAt: string;
    units: number;
    returns: number;
    hasReturns: boolean;
    rating: number | null;
    ratingAt: string;
  };
  const pAgg = new Map<string, PAgg>();
  for (const r of pmRows) {
    if (!r.sku) continue;
    const k = skuKey(r.brand_id, r.sku);
    const a =
      pAgg.get(k) ??
      ({
        brandId: r.brand_id,
        sku: r.sku,
        productName: null,
        nameAt: "",
        units: 0,
        returns: 0,
        hasReturns: false,
        rating: null,
        ratingAt: "",
      } as PAgg);
    a.units += num(r.units);
    if (r.returns != null) {
      a.returns += Number(r.returns);
      a.hasReturns = true;
    }
    // "Latest" rating + product name by period_end, then created_at as a tiebreak.
    const sortAt = `${r.period_end ?? ""}|${r.created_at ?? ""}`;
    if (r.product_rating != null && sortAt >= a.ratingAt) {
      a.rating = Number(r.product_rating);
      a.ratingAt = sortAt;
    }
    if ((r.product_name ?? "").trim() && sortAt >= a.nameAt) {
      a.productName = r.product_name;
      a.nameAt = sortAt;
    }
    pAgg.set(k, a);
  }

  const products: ProductQualityFacts[] = Array.from(pAgg.values()).map((a) => ({
    brandId: a.brandId,
    brandName: a.brandId ? brandName.get(a.brandId) ?? null : null,
    sku: a.sku,
    productName: a.productName,
    productRating: a.rating,
    units: a.units,
    returns: a.hasReturns ? a.returns : null,
    returnRatio: a.hasReturns && a.units > 0 ? a.returns / a.units : null,
  }));

  return {
    brands,
    products,
    window: { start: win.start, end: win.end },
    priorWindow: { start: prior.start, end: prior.end },
    isoWeek,
  };
}
