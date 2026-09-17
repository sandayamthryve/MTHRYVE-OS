// lib/metrics/tiktok-live.ts — the live, auto-populated per-brand commerce reader.
//
// This is what lets the Brand Portfolio / Commerce view fill itself in instead of
// waiting for someone to type numbers into a form. It reads the ALREADY-SYNCED
// landing tables directly:
//   • tiktok_shop_performance — daily per-shop GMV / orders / units / visitors /
//     page_views / conversion_rate (the live TikTok Shop numbers), and
//   • tiktok_settlements — the finance/settlement rows (net payout + refunds).
//
// Both tables are org-scoped-readable under RLS (`org_id = current_org_id()`), so
// this reads through the ordinary request-scoped server client — NO service role,
// NO write, and it NEVER triggers a TikTok backfill. It only surfaces what the
// daily read-sync already landed (protecting the audited historical GMV).
//
// Honesty by construction: a shop may report GMV before the analytics scope lands
// visitors/conversion, and a brand may span multiple shops. We SUM the additive
// figures across a brand's shops per day and DERIVE conversion as orders ÷
// visitors (never an average of rates); a metric with no reported value stays
// null so the UI shows "—", never a fabricated 0.
//
// The tiktok_* landing tables aren't in the generated Database type (they're
// operational tables provisioned outside the app migrations), so — exactly like
// lib/metrics/freshness.ts and lib/tiktok/reconcile.ts — we read them through a
// minimal structural shim rather than `any`.

import type { createServerSupabaseClient } from "@/lib/supabase/server";

type Client = ReturnType<typeof createServerSupabaseClient>;

interface Filter<Row> extends Promise<{ data: Row[] | null; error: unknown }> {
  eq(col: string, val: string): Filter<Row>;
  order(col: string, opts: { ascending: boolean }): Filter<Row>;
}
interface LiveDb {
  from(t: string): { select(cols: string): Filter<Record<string, unknown>> };
}

function db(supabase: Client): LiveDb {
  return supabase as unknown as LiveDb;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

// One brand's commerce numbers for a single Manila calendar day, summed across
// every shop that maps to the brand.
export interface BrandDay {
  statDate: string; // YYYY-MM-DD
  gmv: number;
  orders: number;
  units: number;
  visitors: number | null; // null when no shop reported visitors that day
  pageViews: number | null;
  conversionRate: number | null; // orders ÷ visitors (0..1), guarded
  currency: string;
  source: string; // e.g. "tiktok_api"
}

// A brand's settlement roll-up across the settlement rows we've synced.
export interface SettlementSummary {
  net: number; // Σ net_amount (the payout)
  refund: number; // Σ |refund_amount|
  gross: number | null; // Σ gross_amount (null if none reported)
  statements: number;
  asOf: string | null; // latest settlement stat_date
  currency: string;
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Format a plain YYYY-MM-DD stat_date as "Jul 12, 2026" WITHOUT any timezone
// shift (stat_date is already a Manila calendar day, not a timestamp).
export function fmtStatDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const [, y, mo, day] = m;
  const monthIdx = Number(mo) - 1;
  const label = SHORT_MONTHS[monthIdx] ?? mo;
  return `${label} ${Number(day)}, ${y}`;
}

// --- Shop-performance readers ------------------------------------------------

const SHOP_PERF_COLS =
  "brand_id, stat_date, gmv, orders, units, visitors, page_views, conversion_rate, currency, source";

interface RawPerfRow {
  brand_id: unknown;
  stat_date: unknown;
  gmv: unknown;
  orders: unknown;
  units: unknown;
  visitors: unknown;
  page_views: unknown;
  conversion_rate: unknown;
  currency: unknown;
  source: unknown;
}

// Fold the raw per-shop daily rows into per-(brand, day) totals. Additive fields
// are summed; conversion is derived from the summed orders/visitors so multiple
// shops never average their rates. Returns Map<brandId, BrandDay[] ascending>.
function foldPerf(rows: RawPerfRow[]): Map<string, BrandDay[]> {
  // brandId -> statDate -> accumulator
  type Acc = {
    gmv: number;
    orders: number;
    units: number;
    visitors: number | null;
    pageViews: number | null;
    currency: string;
    source: string;
  };
  const byBrand = new Map<string, Map<string, Acc>>();

  for (const r of rows) {
    const brand = str(r.brand_id);
    const day = str(r.stat_date);
    if (!brand || !day) continue; // unmapped shops can't be attributed to a brand
    let days = byBrand.get(brand);
    if (!days) {
      days = new Map<string, Acc>();
      byBrand.set(brand, days);
    }
    const acc =
      days.get(day) ??
      ({ gmv: 0, orders: 0, units: 0, visitors: null, pageViews: null, currency: "PHP", source: "" } as Acc);
    acc.gmv += num(r.gmv) ?? 0;
    acc.orders += num(r.orders) ?? 0;
    acc.units += num(r.units) ?? 0;
    const vis = num(r.visitors);
    if (vis !== null) acc.visitors = (acc.visitors ?? 0) + vis;
    const pv = num(r.page_views);
    if (pv !== null) acc.pageViews = (acc.pageViews ?? 0) + pv;
    acc.currency = str(r.currency) ?? acc.currency;
    if (!acc.source) acc.source = str(r.source) ?? "";
    days.set(day, acc);
  }

  const out = new Map<string, BrandDay[]>();
  for (const [brand, days] of byBrand) {
    const series = Array.from(days.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([statDate, a]): BrandDay => ({
        statDate,
        gmv: a.gmv,
        orders: a.orders,
        units: a.units,
        visitors: a.visitors,
        pageViews: a.pageViews,
        // Derived conversion: orders ÷ visitors, guarded against divide-by-zero.
        conversionRate: a.visitors && a.visitors > 0 ? a.orders / a.visitors : null,
        currency: a.currency,
        source: a.source || "tiktok_api",
      }));
    out.set(brand, series);
  }
  return out;
}

// `orgId` is an OPTIONAL explicit org scope. Under the request-scoped RLS client it
// is redundant (RLS already restricts to current_org_id()), but a SERVICE-ROLE
// caller (e.g. the Vesper executor) bypasses RLS, so it must pass orgId to avoid
// reading across orgs — the same explicit-scope discipline the scoreboard uses.
async function loadPerf(supabase: Client, brandId?: string, orgId?: string): Promise<RawPerfRow[]> {
  let q = db(supabase).from("tiktok_shop_performance").select(SHOP_PERF_COLS);
  if (orgId) q = q.eq("org_id", orgId);
  if (brandId) q = q.eq("brand_id", brandId);
  q = q.order("stat_date", { ascending: true });
  const { data } = await q;
  return (data ?? []) as unknown as RawPerfRow[];
}

/** Every brand's live daily commerce series (ascending), keyed by brand id. */
export async function getLiveDaysByBrand(
  supabase: Client,
  orgId?: string
): Promise<Map<string, BrandDay[]>> {
  return foldPerf(await loadPerf(supabase, undefined, orgId));
}

/** One brand's live daily commerce series, ascending by day. */
export async function getBrandLiveDays(
  supabase: Client,
  brandId: string,
  orgId?: string
): Promise<BrandDay[]> {
  return foldPerf(await loadPerf(supabase, brandId, orgId)).get(brandId) ?? [];
}

/** The latest live day per brand (the "as of" snapshot the portfolio shows). */
export async function getLiveLatestByBrand(supabase: Client): Promise<Map<string, BrandDay>> {
  const byBrand = await getLiveDaysByBrand(supabase);
  const latest = new Map<string, BrandDay>();
  for (const [brand, series] of byBrand) {
    const last = series[series.length - 1];
    if (last) latest.set(brand, last);
  }
  return latest;
}

// --- Settlement readers ------------------------------------------------------

const SETTLE_COLS =
  "brand_id, stat_date, gross_amount, fee_amount, refund_amount, net_amount, currency";

interface RawSettleRow {
  brand_id: unknown;
  stat_date: unknown;
  gross_amount: unknown;
  refund_amount: unknown;
  net_amount: unknown;
  currency: unknown;
}

function foldSettlements(rows: RawSettleRow[]): Map<string, SettlementSummary> {
  type Acc = { net: number; refund: number; gross: number | null; statements: number; asOf: string | null; currency: string };
  const byBrand = new Map<string, Acc>();
  for (const r of rows) {
    const brand = str(r.brand_id);
    if (!brand) continue;
    const acc =
      byBrand.get(brand) ?? { net: 0, refund: 0, gross: null, statements: 0, asOf: null, currency: "PHP" };
    acc.net += num(r.net_amount) ?? 0;
    acc.refund += Math.abs(num(r.refund_amount) ?? 0);
    const g = num(r.gross_amount);
    if (g !== null) acc.gross = (acc.gross ?? 0) + g;
    acc.statements += 1;
    acc.currency = str(r.currency) ?? acc.currency;
    const day = str(r.stat_date);
    if (day && (acc.asOf === null || day > acc.asOf)) acc.asOf = day;
    byBrand.set(brand, acc);
  }
  return byBrand;
}

async function loadSettlements(supabase: Client, brandId?: string): Promise<RawSettleRow[]> {
  let q = db(supabase).from("tiktok_settlements").select(SETTLE_COLS);
  if (brandId) q = q.eq("brand_id", brandId);
  const { data } = await q;
  return (data ?? []) as unknown as RawSettleRow[];
}

/** Every brand's settlement roll-up, keyed by brand id. */
export async function getSettlementByBrand(supabase: Client): Promise<Map<string, SettlementSummary>> {
  return foldSettlements(await loadSettlements(supabase));
}

/** One brand's settlement roll-up (null when the brand has no settlement rows). */
export async function getBrandSettlement(
  supabase: Client,
  brandId: string
): Promise<SettlementSummary | null> {
  return foldSettlements(await loadSettlements(supabase, brandId)).get(brandId) ?? null;
}

// --- Range-aware windowed aggregation (the ONE live-commerce code path) -------
//
// PR 3 retires brand_platform_metrics: every GMV/commerce surface now sums the
// live per-brand tiktok_shop_performance series over an explicit window through
// these helpers, so per-brand, company and every page reconcile BY CONSTRUCTION —
// company == Σ brands, because both sides are Σ of the SAME per-(brand,day) rows.
// tiktok_shop_performance carries commerce only (gmv/orders/units); it has NO
// ad_spend/ad_revenue/roas/returns, so surfaces that used those bpm columns render
// an honest null, never a bpm number.

export interface LiveWindowAgg {
  gmv: number | null; // Σ daily GMV in [start,end]; null when the brand reported nothing
  orders: number | null; // Σ daily orders; null when nothing reported
  units: number | null; // Σ daily units; null when nothing reported
  matchedDays: number; // daily rows that fell in the window (0 ⇒ all-null agg)
}

// Sum ONE brand's daily series over an inclusive [start,end] (YYYY-MM-DD compare;
// stat_date is already a Manila calendar day, so a lexicographic compare is an
// exact date compare). RAW sums — rounding is deferred to the point of display so
// a company total can round its Σ once (per-brand rounding first would let
// sub-peso remainders drift the company total). A brand that reported nothing in
// the window returns nulls (honest "—", never a fabricated 0).
export function sumBrandWindow(
  days: BrandDay[] | undefined,
  start: string,
  end: string
): LiveWindowAgg {
  if (!days || days.length === 0) return { gmv: null, orders: null, units: null, matchedDays: 0 };
  let gmv = 0;
  let orders = 0;
  let units = 0;
  let matched = 0;
  for (const d of days) {
    if (d.statDate >= start && d.statDate <= end) {
      gmv += d.gmv;
      orders += d.orders;
      units += d.units;
      matched += 1;
    }
  }
  if (matched === 0) return { gmv: null, orders: null, units: null, matchedDays: 0 };
  return { gmv, orders, units, matchedDays: matched };
}

export interface OrgWindowAgg {
  gmv: number | null; // Σ over brands (raw); null when NO brand reported in the window
  orders: number | null;
  units: number | null;
  activeBrands: number; // distinct brand_id with >0 GMV in the window
  byBrand: Map<string, LiveWindowAgg>; // per-brand raw aggregates for the SAME window
}

// Org aggregate PLUS the per-brand breakdown from the SAME live map, so a surface
// renders company and every brand knowing company == Σ brands by construction. The
// company Σ is RAW (unrounded); callers round at the point of display. gmv/orders
// are null only when EVERY brand is null — an honest "—" iff nobody reported, never
// a fabricated 0.
export function orgWindow(
  liveByBrand: Map<string, BrandDay[]>,
  start: string,
  end: string
): OrgWindowAgg {
  const byBrand = new Map<string, LiveWindowAgg>();
  let gmv = 0;
  let orders = 0;
  let units = 0;
  let anyGmv = false;
  let anyOrders = false;
  let anyUnits = false;
  let active = 0;
  for (const [brand, days] of liveByBrand) {
    const a = sumBrandWindow(days, start, end);
    byBrand.set(brand, a);
    if (a.gmv != null) {
      gmv += a.gmv;
      anyGmv = true;
      if (a.gmv > 0) active += 1;
    }
    if (a.orders != null) {
      orders += a.orders;
      anyOrders = true;
    }
    if (a.units != null) {
      units += a.units;
      anyUnits = true;
    }
  }
  return {
    gmv: anyGmv ? gmv : null,
    orders: anyOrders ? orders : null,
    units: anyUnits ? units : null,
    activeBrands: active,
    byBrand,
  };
}

// Σ TikTok GMV across every brand for an inclusive [start,end] window (RAW). A
// genuinely empty window returns 0 — used for the weekly Revenue Pulse bars, where
// a real, measured zero week is meaningful (unlike a metric-level "—").
export function sumOrgGmvWindow(
  liveByBrand: Map<string, BrandDay[]>,
  start: string,
  end: string
): number {
  return orgWindow(liveByBrand, start, end).gmv ?? 0;
}
