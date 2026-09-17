// lib/metrics/gmv.ts — the ONE GMV/commerce aggregation helper used everywhere.
//
// SOURCE (PR 3): every GMV figure the OS renders (Command Center, Brand Portfolio,
// Reports, Finance, CEO, Tony, Scoreboard, Contracts) now comes from
// public.tiktok_shop_performance via lib/metrics/tiktok-live — the SAME live
// per-brand reader lib/os/snapshot.ts and lib/ceo/mission-control.ts use.
// brand_platform_metrics is RETIRED for display reads: it disagreed with the live
// TikTok figures on every brand in both directions (over/under-count + phantom
// revenue) and its writer trailed the live table by days. fetchCommerceRows()
// below reads the live table and hands aggregate() a clean set of per-(brand, day)
// rows; the ONLY thing still summed over real brand_platform_metrics rows is the
// reconcile writer's own self-verify (lib/tiktok/reconcile.ts) — it feeds its own
// rows into the same pure aggregate(), so that path is unaffected.
//
// tiktok_shop_performance carries commerce only (gmv / orders / units); it has NO
// ad_spend / ad_revenue / roas / returns columns, so those arrive null and every
// derived ad/return figure resolves to an HONEST NULL ("—"), never a bpm number
// and never a fabricated 0.
//
// THE GUARANTEE — sum of per-brand GMV for a window === org GMV for that window:
// org totals are computed as Σ over (brand, platform) groups, and per-brand
// totals as Σ over that same brand's (brand, platform) groups. Because the org
// groups are exactly the disjoint union of every brand's groups, the org total
// is the sum of the brand totals BY CONSTRUCTION — see aggregate() below. The
// same per-group collapse runs in both paths, so overlapping/duplicate periods
// can never double-count on one side but not the other.
//
// Real data only: a null numeric is treated as "not reported" (contributes 0 to
// a sum but never invents a value); hasData tells the UI whether to render a
// figure or an honest "no data yet" empty state. Divide-by-zero on AOV / ROAS /
// return-rate yields null, never NaN or a fabricated 0; and an ad/return metric
// with NO reported row anywhere in the window stays null (not 0) so a surface
// shows "—" rather than implying a real, measured zero.

import type { Database } from "@/types/database";
import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ResolvedWindow } from "./windows";
import { getLiveDaysByBrand, getBrandLiveDays, type BrandDay } from "./tiktok-live";

// The exact server client type, so callers pass createServerSupabaseClient()
// straight through regardless of the installed @supabase/supabase-js generics.
type Client = ReturnType<typeof createServerSupabaseClient>;

export type Platform = Database["public"]["Enums"]["platform_channel"];

// Sales channels carry commerce (gmv/orders/units/returns); ad channels carry
// spend/revenue/roas. Splitting them keeps brand totals (a sum over sales) and
// ad totals (a sum over ads) from bleeding into each other.
export const SALES_PLATFORMS: Platform[] = ["tiktok_shop", "shopee", "lazada", "other"];
export const AD_PLATFORMS: Platform[] = ["meta_ads", "tiktok_ads", "google_ads"];

const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok_shop: "TikTok Shop",
  shopee: "Shopee",
  lazada: "Lazada",
  other: "Other",
  meta_ads: "Meta Ads",
  tiktok_ads: "TikTok Ads",
  google_ads: "Google Ads",
};

export function platformLabel(p: Platform | string): string {
  return PLATFORM_LABEL[p as Platform] ?? p;
}

export function isSalesPlatform(p: Platform | string): boolean {
  return (SALES_PLATFORMS as string[]).includes(p);
}
export function isAdPlatform(p: Platform | string): boolean {
  return (AD_PLATFORMS as string[]).includes(p);
}

// The subset of columns aggregation needs. Selected explicitly (no `select *`).
export const BPM_COLUMNS =
  "brand_id, platform, period_start, period_end, gmv, orders, units, returns, return_rate, fulfillment_errors, ad_spend, ad_revenue, roas, currency, source, updated_at";

export interface BpmRow {
  brand_id: string;
  platform: Platform;
  period_start: string;
  period_end: string;
  gmv: number | null;
  orders: number | null;
  units: number | null;
  returns: number | null;
  return_rate: number | null;
  fulfillment_errors: number | null;
  ad_spend: number | null;
  ad_revenue: number | null;
  roas: number | null;
  currency: string;
  source: string;
  updated_at: string;
}

// Per-(platform) aggregate within a window.
export interface PlatformAgg {
  platform: Platform;
  gmv: number;
  orders: number;
  units: number;
  returns: number;
  fulfillmentErrors: number;
  adSpend: number;
  adRevenue: number;
  roas: number | null; // adRevenue / adSpend, guarded
  aov: number | null; // gmv / orders, guarded
  sharePct: number | null; // this platform's share of the aggregate's total GMV
}

// A full aggregate for a window (org-wide, one brand, or one brand×platform).
export interface GmvAgg {
  window: ResolvedWindow;
  gmv: number;
  orders: number;
  units: number;
  returns: number;
  fulfillmentErrors: number;
  adSpend: number;
  adRevenue: number;
  roas: number | null;
  aov: number | null;
  returnRate: number | null; // returns / orders, guarded
  byPlatform: PlatformAgg[]; // only platforms with a matched row, sorted by GMV desc
  hasData: boolean; // at least one row matched the window
  // Whether ANY matched row actually reported ad / return data. The live commerce
  // source (tiktok_shop_performance) carries neither, so these are false there and a
  // consumer can render an honest "—" instead of treating a 0 sum as a real figure.
  hasAdData: boolean;
  hasReturnData: boolean;
  currency: string; // dominant currency (defaults PHP)
}

const num = (v: number | null | undefined): number => (v == null ? 0 : Number(v));

// A row is attributed to a window by its period_end (the codebase convention).
function inWindow(r: BpmRow, w: ResolvedWindow): boolean {
  return r.period_end >= w.start && r.period_end <= w.end;
}

// Higher rank wins when the same exact period exists under multiple sources
// (the table's unique key is per-source, so an import + a windsor pull could
// both hold the same week). Prefer an automated/live pull, then audits, then
// hand entry — so a re-imported number never double-counts and the most
// authoritative source is the one kept.
function sourceRank(source: string): number {
  const s = source.toLowerCase();
  if (/\b(api|sync|windsor|live|webhook|connector)\b/.test(s)) return 4;
  if (s.includes("audit")) return 3;
  if (s.includes("import")) return 2;
  if (s.includes("manual")) return 1;
  return 0;
}

// Collapse one (brand, platform) group to a non-overlapping, non-duplicated set
// of rows, then sum. Deterministic so both the org path and the brand path
// collapse an identical group identically.
function collapseGroup(rows: BpmRow[]): {
  gmv: number;
  orders: number;
  units: number;
  returns: number;
  fulfillmentErrors: number;
  adSpend: number;
  adRevenue: number;
  kept: number;
  // Whether ANY kept row actually reported returns / ad data. Lets aggregate keep
  // a derived return-rate / ROAS null (an honest "—") instead of a fabricated 0
  // when the source carries no such column — e.g. tiktok_shop_performance, which
  // has no returns/ad columns at all.
  hasReturns: boolean;
  hasAd: boolean;
} {
  // 1. Dedupe by exact period, keeping the highest-ranked source (newest wins a
  //    tie) so the same week reported twice counts once.
  const byPeriod = new Map<string, BpmRow>();
  for (const r of rows) {
    const key = `${r.period_start}|${r.period_end}`;
    const prev = byPeriod.get(key);
    if (
      !prev ||
      sourceRank(r.source) > sourceRank(prev.source) ||
      (sourceRank(r.source) === sourceRank(prev.source) && r.updated_at > prev.updated_at)
    ) {
      byPeriod.set(key, r);
    }
  }

  // 2. Drop overlapping date ranges greedily: sort by start asc (longer span
  //    first on a tie) and keep a row only if it starts after the last kept
  //    period ended. A shorter range nested inside a kept one is dropped.
  const sorted = Array.from(byPeriod.values()).sort(
    (a, b) => (a.period_start < b.period_start ? -1 : a.period_start > b.period_start ? 1 : b.period_end.localeCompare(a.period_end))
  );

  let lastEnd = "";
  const acc = {
    gmv: 0, orders: 0, units: 0, returns: 0, fulfillmentErrors: 0, adSpend: 0, adRevenue: 0,
    kept: 0, hasReturns: false, hasAd: false,
  };
  for (const r of sorted) {
    if (lastEnd && r.period_start <= lastEnd) continue; // overlaps a kept row
    lastEnd = r.period_end;
    acc.gmv += num(r.gmv);
    acc.orders += num(r.orders);
    acc.units += num(r.units);
    acc.returns += num(r.returns);
    acc.fulfillmentErrors += num(r.fulfillment_errors);
    acc.adSpend += num(r.ad_spend);
    acc.adRevenue += num(r.ad_revenue);
    if (r.returns != null || r.return_rate != null) acc.hasReturns = true;
    if (r.ad_spend != null || r.ad_revenue != null) acc.hasAd = true;
    acc.kept += 1;
  }
  return acc;
}

function safeDiv(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

export interface AggregateOpts {
  brandId?: string;
  platform?: Platform;
}

// The core aggregator. Filters rows to the window (and optional brand/platform),
// groups by (brand, platform), collapses each group, and folds the results into
// per-platform aggregates and grand totals. Pure — no I/O.
export function aggregate(rows: BpmRow[], window: ResolvedWindow, opts: AggregateOpts = {}): GmvAgg {
  const groups = new Map<string, BpmRow[]>();
  const currencyCount = new Map<string, number>();

  for (const r of rows) {
    if (opts.brandId && r.brand_id !== opts.brandId) continue;
    if (opts.platform && r.platform !== opts.platform) continue;
    if (!inWindow(r, window)) continue;
    const key = `${r.brand_id}::${r.platform}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
    currencyCount.set(r.currency, (currencyCount.get(r.currency) ?? 0) + 1);
  }

  const perPlatform = new Map<Platform, PlatformAgg>();
  // Per-platform + org presence of returns/ad data — drives honest-null derived
  // figures (a platform with no ad rows gets roas=null, not a fabricated 0).
  const perPlatformFlags = new Map<Platform, { hasReturns: boolean; hasAd: boolean }>();
  const totals = { gmv: 0, orders: 0, units: 0, returns: 0, fulfillmentErrors: 0, adSpend: 0, adRevenue: 0 };
  let orgHasReturns = false;
  let orgHasAd = false;
  let keptTotal = 0;

  for (const [key, groupRows] of groups) {
    const platform = key.split("::")[1] as Platform;
    const c = collapseGroup(groupRows);
    keptTotal += c.kept;
    if (c.hasReturns) orgHasReturns = true;
    if (c.hasAd) orgHasAd = true;
    const pf = perPlatformFlags.get(platform) ?? { hasReturns: false, hasAd: false };
    pf.hasReturns = pf.hasReturns || c.hasReturns;
    pf.hasAd = pf.hasAd || c.hasAd;
    perPlatformFlags.set(platform, pf);

    const p =
      perPlatform.get(platform) ??
      ({
        platform,
        gmv: 0,
        orders: 0,
        units: 0,
        returns: 0,
        fulfillmentErrors: 0,
        adSpend: 0,
        adRevenue: 0,
        roas: null,
        aov: null,
        sharePct: null,
      } as PlatformAgg);
    p.gmv += c.gmv;
    p.orders += c.orders;
    p.units += c.units;
    p.returns += c.returns;
    p.fulfillmentErrors += c.fulfillmentErrors;
    p.adSpend += c.adSpend;
    p.adRevenue += c.adRevenue;
    perPlatform.set(platform, p);

    totals.gmv += c.gmv;
    totals.orders += c.orders;
    totals.units += c.units;
    totals.returns += c.returns;
    totals.fulfillmentErrors += c.fulfillmentErrors;
    totals.adSpend += c.adSpend;
    totals.adRevenue += c.adRevenue;
  }

  // Finalize per-platform derived figures + GMV share of the aggregate total.
  const byPlatform = Array.from(perPlatform.values())
    .map((p) => ({
      ...p,
      // ROAS only when this platform actually reported ad data — else honest null.
      roas: perPlatformFlags.get(p.platform)?.hasAd ? safeDiv(p.adRevenue, p.adSpend) : null,
      aov: safeDiv(p.gmv, p.orders),
      sharePct: totals.gmv > 0 && isSalesPlatform(p.platform) ? (p.gmv / totals.gmv) * 100 : null,
    }))
    .sort((a, b) => b.gmv - a.gmv || a.platform.localeCompare(b.platform));

  const currency =
    Array.from(currencyCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "PHP";

  return {
    window,
    gmv: totals.gmv,
    orders: totals.orders,
    units: totals.units,
    returns: totals.returns,
    fulfillmentErrors: totals.fulfillmentErrors,
    adSpend: totals.adSpend,
    adRevenue: totals.adRevenue,
    // ROAS / return-rate only when the source actually carried ad / return data
    // in the window — otherwise null (honest "—"), never a fabricated 0.
    roas: orgHasAd ? safeDiv(totals.adRevenue, totals.adSpend) : null,
    aov: safeDiv(totals.gmv, totals.orders),
    returnRate: orgHasReturns ? safeDiv(totals.returns, totals.orders) : null,
    byPlatform,
    hasData: keptTotal > 0,
    hasAdData: orgHasAd,
    hasReturnData: orgHasReturns,
    currency,
  };
}

// Build the commerce rows aggregate() consumes from the LIVE per-brand
// tiktok_shop_performance series (lib/metrics/tiktok-live). Each per-(brand, day)
// live total becomes ONE platform='tiktok_shop' row whose period is that single
// Manila day (period_start == period_end == stat_date); the ad/return columns the
// live table does not carry stay null, so every derived ad/return figure resolves
// to an honest "—" downstream. This is the ONLY commerce source display surfaces
// read — brand_platform_metrics is RETIRED for reads (see the module header).
// Exported so the metrics_snapshots rollup (lib/metrics/rollup) can fold the SAME
// live per-brand series it sums for GMV into the BpmRow shape qualityFrom scores —
// one read of tiktok_shop_performance feeds both, with no second mapper to drift.
export function brandDayToRow(brandId: string, d: BrandDay): BpmRow {
  return {
    brand_id: brandId,
    platform: "tiktok_shop",
    period_start: d.statDate,
    period_end: d.statDate,
    gmv: d.gmv,
    orders: d.orders,
    units: d.units,
    returns: null,
    return_rate: null,
    fulfillment_errors: null,
    ad_spend: null,
    ad_revenue: null,
    roas: null,
    currency: d.currency,
    source: d.source,
    updated_at: d.statDate,
  };
}

// Fetch org-scoped commerce rows from the live TikTok Shop table (RLS applies via
// the passed client). Optionally scope to one brand so a per-brand page reads only
// what it needs. Replaces the old brand_platform_metrics fetch of the same name.
// `orgId` is only needed by a SERVICE-ROLE caller (RLS-bypassing) to keep the read
// org-scoped; a request-scoped client can omit it (RLS scopes the read already).
export async function fetchCommerceRows(
  supabase: Client,
  opts: { brandId?: string; orgId?: string } = {}
): Promise<BpmRow[]> {
  if (opts.brandId) {
    const days = await getBrandLiveDays(supabase, opts.brandId, opts.orgId);
    return days.map((d) => brandDayToRow(opts.brandId as string, d));
  }
  const byBrand = await getLiveDaysByBrand(supabase, opts.orgId);
  const rows: BpmRow[] = [];
  for (const [brandId, days] of byBrand) {
    for (const d of days) rows.push(brandDayToRow(brandId, d));
  }
  return rows;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface OrgGmvArgs {
  supabase: Client;
  window: ResolvedWindow;
  platform?: Platform;
  rows?: BpmRow[]; // pass pre-fetched rows to avoid a second round-trip
}

export interface BrandGmvArgs extends OrgGmvArgs {
  brandId: string;
}

/** Org-wide commerce aggregate for a window. */
export async function getOrgGmv(args: OrgGmvArgs): Promise<GmvAgg> {
  const rows = args.rows ?? (await fetchCommerceRows(args.supabase));
  return aggregate(rows, args.window, { platform: args.platform });
}

/** Single-brand commerce aggregate for a window. */
export async function getBrandGmv(args: BrandGmvArgs): Promise<GmvAgg> {
  const rows = args.rows ?? (await fetchCommerceRows(args.supabase, { brandId: args.brandId }));
  return aggregate(rows, args.window, { brandId: args.brandId, platform: args.platform });
}

// Org aggregate PLUS a per-brand breakdown from the SAME fetched rows, so a page
// can render the org total and each brand's total knowing they reconcile.
export async function getOrgGmvByBrand(
  supabase: Client,
  window: ResolvedWindow,
  platform?: Platform
): Promise<{ org: GmvAgg; byBrand: Map<string, GmvAgg>; rows: BpmRow[] }> {
  const rows = await fetchCommerceRows(supabase);
  const org = aggregate(rows, window, { platform });
  const brandIds = new Set<string>();
  for (const r of rows) brandIds.add(r.brand_id);
  const byBrand = new Map<string, GmvAgg>();
  for (const id of brandIds) byBrand.set(id, aggregate(rows, window, { brandId: id, platform }));
  return { org, byBrand, rows };
}

// Dev-only invariant check: the org GMV total must equal the sum of every
// brand's GMV total for the window. Logs a loud error if it ever drifts (it
// shouldn't — the equality is structural). No-op in production.
export function devAssertOrgEqualsBrandSum(rows: BpmRow[], window: ResolvedWindow): void {
  if (process.env.NODE_ENV === "production") return;
  const org = aggregate(rows, window);
  const brandIds = new Set(rows.map((r) => r.brand_id));
  let sum = 0;
  for (const id of brandIds) sum += aggregate(rows, window, { brandId: id }).gmv;
  // Allow a sub-cent rounding tolerance from float addition.
  if (Math.abs(sum - org.gmv) > 0.01) {
    // eslint-disable-next-line no-console
    console.error(
      `[metrics] GMV consistency FAILED for '${window.label}' (${window.start}..${window.end}): ` +
        `org=${org.gmv} sumOfBrands=${sum} diff=${org.gmv - sum}`
    );
  }
}
