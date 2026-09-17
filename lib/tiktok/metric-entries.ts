import { createServiceRoleClient } from "@/lib/supabase/service";

// The TikTok Shop PER-BRAND metric_entries overlay — the second rollup the daily
// sync runs (after reconcile.ts folds the landed data into brand_platform_metrics).
//
// WHY: the COO / E-Commerce reconciliation gate reads the API-validation overlay
// out of public.metric_entries (the ecom.* keys). The daily sync used to leave
// that overlay as ONE org-wide row per metric (brand_id NULL), so the gate could
// only validate the org total — never per brand. This step folds the SAME landed
// per-shop daily rows (tiktok_shop_performance / tiktok_settlements) up to ONE
// row per (brand, metric, window) so each brand (Namiroseus, Standard, …) can be
// reconciled on its own.
//
// BRAND ATTRIBUTION: brand comes from tiktok_shops.brand_id, resolved by joining
// each landed row to its shop on shop_id — NOT from the row's own brand_id
// column, which can be stale on tiktok_settlements. A shop whose brand_id is
// still NULL (none today) is skipped and counted, never silently folded in.
//
// WRITE CONTRACT (matches the api-only overlay in 0025_metric_reconciliation):
//   • Written ONLY through public.apply_metric_api_value() — api_value only,
//     never the manual floor. A fresh row defaults marketplace='tiktok_shop' and
//     origin='api'; the validation trigger derives validation_status='api_only'
//     (or 'reconciled'/'match'/'mismatch' if a manual floor already sits there).
//   • ONE row per (brand_id, metric_key, period_start, period_end) where the
//     period is the sync window and api_value is the brand's summed metric.
//   • Idempotent: re-running a window upserts in place on the natural key.
//   • Replaces the old org-wide roll-up: any api-origin, tiktok_shop, brand-NULL
//     row for a managed ecom.* key that OVERLAPS the window is superseded, so no
//     NULL-brand ecom row is left behind for the gate to double-count.
//   • Archived-aware: the supersede delete never touches archived rows.
//   • Honest nulls: a brand with no landed rows for a source is skipped for that
//     source's metrics, not written as a fabricated 0.
//
// Which keys: exactly the org's auto / auto_possible ecom.* catalog metrics whose
// api_source is a TikTok source (tiktok_shop / tiktok_settlement). Other sources
// (ratings, ads) and manual metrics are left to their own paths.

// --- Public shapes ----------------------------------------------------------

export interface MetricEntriesWindow {
  startDate: string; // inclusive YYYY-MM-DD (Asia/Manila calendar day)
  endDate: string; // inclusive YYYY-MM-DD
}

export interface BrandMetricEntriesResult {
  status: "success" | "error";
  orgs: number; // orgs processed (had a TikTok-sourced ecom.* catalog)
  brands: number; // distinct brands written across orgs
  rowsUpserted: number; // per-brand api_value writes
  supersededOrgRows: number; // org-wide (brand NULL) rows removed to replace them
  skippedNullBrandRows: number; // landed rows whose shop has no brand mapping
  warnings: string[]; // per-org write failures + unmapped-shop notes
  error?: string;
}

// --- Minimal typed DB surface (service role; the tiktok_* / metric_* tables
// aren't in the generated Database type, so we describe just the shapes we use —
// no `any`, mirroring lib/tiktok/reconcile.ts). ------------------------------

interface FilterBuilder<Row> extends Promise<{ data: Row[] | null; error: unknown }> {
  select(cols: string): FilterBuilder<Row>;
  eq(col: string, val: string): FilterBuilder<Row>;
  is(col: string, val: null): FilterBuilder<Row>;
  in(col: string, vals: string[]): FilterBuilder<Row>;
  gte(col: string, val: string): FilterBuilder<Row>;
  lte(col: string, val: string): FilterBuilder<Row>;
}
interface TableApi {
  select(cols: string): FilterBuilder<Record<string, unknown>>;
  delete(): FilterBuilder<{ id: string }>;
}
interface MetricEntriesDb {
  from(table: string): TableApi;
  rpc(fn: string, params: Record<string, unknown>): Promise<{ error: unknown }>;
}

function db(): MetricEntriesDb {
  return createServiceRoleClient() as unknown as MetricEntriesDb;
}

// --- Small helpers ----------------------------------------------------------

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

const orgBrandKey = (org: string, brand: string) => `${org}|${brand}`;
const orgShopKey = (org: string, shop: string) => `${org}|${shop}`;

// Per (org, brand) window totals folded from the landed daily rows. `hadShop` /
// `hadSettle` say whether the brand had ANY row for that source — the honest-null
// gate: no rows ⇒ skip that source's metrics (don't invent a 0).
interface BrandAgg {
  hadShop: boolean;
  hadSettle: boolean;
  gmv: number;
  orders: number;
  units: number;
  visitors: number;
  page_views: number;
  net_amount: number;
  refund_amount: number;
}

function emptyAgg(): BrandAgg {
  return {
    hadShop: false,
    hadSettle: false,
    gmv: 0,
    orders: 0,
    units: 0,
    visitors: 0,
    page_views: 0,
    net_amount: 0,
    refund_amount: 0,
  };
}

interface CatalogMetric {
  metric_key: string;
  api_source: string; // 'tiktok_shop' | 'tiktok_settlement'
  api_field: string;
}

// Map one catalog metric onto the brand's window aggregate. Returns null when the
// source had no rows for the brand (honest null) or the api_field isn't one this
// rollup can compute — mirrors lib/metrics/sync.ts's resolveValue, per brand and
// scoped to the TikTok sources. A rate (conversion) is derived from the window
// totals, never averaged across days.
function resolveBrandValue(metric: CatalogMetric, a: BrandAgg): number | null {
  if (metric.api_source === "tiktok_shop") {
    if (!a.hadShop) return null;
    switch (metric.api_field) {
      case "gmv":
        return a.gmv;
      case "orders":
        return a.orders;
      case "units":
        return a.units;
      case "visitors":
        return a.visitors;
      case "page_views":
        return a.page_views;
      case "conversion_rate":
        return a.visitors > 0 ? a.orders / a.visitors : 0;
      default:
        return null;
    }
  }
  if (metric.api_source === "tiktok_settlement") {
    if (!a.hadSettle) return null;
    switch (metric.api_field) {
      case "net_amount":
        return a.net_amount;
      case "refund_amount":
        return a.refund_amount;
      default:
        return null;
    }
  }
  return null;
}

// --- Loaders ----------------------------------------------------------------

// shop_id → brand_id for every TikTok shop (optionally one org). NULL-brand shops
// are kept in the map as null so a landed row for them is explicitly skipped
// (counted), not treated as "unknown shop".
async function loadShopBrandMap(orgId?: string): Promise<Map<string, string | null>> {
  let q = db().from("tiktok_shops").select("org_id, shop_id, brand_id");
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q;
  if (error) throw new Error(`load tiktok_shops failed: ${JSON.stringify(error)}`);
  const map = new Map<string, string | null>();
  for (const r of data ?? []) {
    const org = str(r.org_id);
    const shop = str(r.shop_id);
    if (!org || !shop) continue;
    map.set(orgShopKey(org, shop), str(r.brand_id));
  }
  return map;
}

// --- Orchestrator -----------------------------------------------------------

// Fold the landed TikTok data into per-brand metric_entries for a window,
// optionally scoped to one org (the manual / end-of-sync path) or all orgs (cron).
// Never throws for a single org — each org is isolated so one failure can't abort
// the rest.
export async function syncBrandMetricEntries(opts: {
  orgId?: string;
  window: MetricEntriesWindow;
}): Promise<BrandMetricEntriesResult> {
  const { orgId, window: win } = opts;
  const warnings: string[] = [];

  const shopBrand = await loadShopBrandMap(orgId);

  // Catalog: the auto / auto_possible ecom.* metrics whose source is a TikTok
  // source. These are the only keys this rollup owns (and the only org-wide rows
  // it may supersede).
  let catQ = db()
    .from("metric_catalog")
    .select("org_id, metric_key, lane, api_source, api_field")
    .in("api_source", ["tiktok_shop", "tiktok_settlement"])
    .in("lane", ["auto", "auto_possible"]);
  if (orgId) catQ = catQ.eq("org_id", orgId);
  const { data: catData, error: catErr } = await catQ;
  if (catErr) throw new Error(`load metric_catalog failed: ${JSON.stringify(catErr)}`);
  const catalogByOrg = new Map<string, CatalogMetric[]>();
  for (const r of catData ?? []) {
    const org = str(r.org_id);
    const key = str(r.metric_key);
    const source = str(r.api_source);
    const field = str(r.api_field);
    if (!org || !key || !source || !field) continue;
    if (!key.startsWith("ecom.")) continue; // this rollup is the ecom.* overlay
    const list = catalogByOrg.get(org) ?? [];
    list.push({ metric_key: key, api_source: source, api_field: field });
    catalogByOrg.set(org, list);
  }

  // Landed sources for the window. Brand is resolved by the shop→brand map, so a
  // stale row-level brand_id can't misattribute (or drop) a shop's numbers.
  let perfQ = db()
    .from("tiktok_shop_performance")
    .select("org_id, shop_id, gmv, orders, units, visitors, page_views")
    .gte("stat_date", win.startDate)
    .lte("stat_date", win.endDate);
  if (orgId) perfQ = perfQ.eq("org_id", orgId);

  let settleQ = db()
    .from("tiktok_settlements")
    .select("org_id, shop_id, net_amount, refund_amount")
    .gte("stat_date", win.startDate)
    .lte("stat_date", win.endDate);
  if (orgId) settleQ = settleQ.eq("org_id", orgId);

  const [perfRes, settleRes] = await Promise.all([perfQ, settleQ]);
  if (perfRes.error)
    throw new Error(`load tiktok_shop_performance failed: ${JSON.stringify(perfRes.error)}`);
  if (settleRes.error)
    throw new Error(`load tiktok_settlements failed: ${JSON.stringify(settleRes.error)}`);

  const byBrand = new Map<string, BrandAgg>(); // key = org|brand
  let skippedNullBrandRows = 0;
  const unmappedShops = new Set<string>();

  // Resolve a landed row's (org, brand); null ⇒ skip + account for it.
  const resolveBrand = (org: string | null, shop: string | null): { org: string; brand: string } | null => {
    if (!org || !shop) return null;
    const k = orgShopKey(org, shop);
    if (!shopBrand.has(k)) {
      unmappedShops.add(k);
      return null;
    }
    const brand = shopBrand.get(k) ?? null;
    if (!brand) return null;
    return { org, brand };
  };

  for (const r of perfRes.data ?? []) {
    const res = resolveBrand(str(r.org_id), str(r.shop_id));
    if (!res) {
      skippedNullBrandRows += 1;
      continue;
    }
    const key = orgBrandKey(res.org, res.brand);
    const agg = byBrand.get(key) ?? emptyAgg();
    agg.hadShop = true;
    agg.gmv += num(r.gmv);
    agg.orders += num(r.orders);
    agg.units += num(r.units);
    agg.visitors += num(r.visitors);
    agg.page_views += num(r.page_views);
    byBrand.set(key, agg);
  }

  for (const r of settleRes.data ?? []) {
    const res = resolveBrand(str(r.org_id), str(r.shop_id));
    if (!res) {
      skippedNullBrandRows += 1;
      continue;
    }
    const key = orgBrandKey(res.org, res.brand);
    const agg = byBrand.get(key) ?? emptyAgg();
    agg.hadSettle = true;
    agg.net_amount += num(r.net_amount);
    agg.refund_amount += num(r.refund_amount);
    byBrand.set(key, agg);
  }

  if (unmappedShops.size > 0) {
    warnings.push(
      `${skippedNullBrandRows} landed row(s) skipped — no brand mapping for shop(s): ` +
        `${Array.from(unmappedShops).join(", ")}`
    );
  } else if (skippedNullBrandRows > 0) {
    warnings.push(`${skippedNullBrandRows} landed row(s) skipped — shop brand_id still NULL`);
  }

  const brandsWritten = new Set<string>();
  let rowsUpserted = 0;
  let supersededOrgRows = 0;
  let anyError = false;

  // Orgs whose window actually landed brand-attributed data. The supersede below
  // is gated on this so a sync that pulled NOTHING for the window can never wipe a
  // previously-good org-wide roll-up (we only replace when we have real rows).
  const orgsWithData = new Set<string>();
  for (const key of byBrand.keys()) orgsWithData.add(key.split("|")[0]);

  const orgs = Array.from(catalogByOrg.keys()).sort();
  for (const org of orgs) {
    const metrics = catalogByOrg.get(org) ?? [];
    if (metrics.length === 0) continue;
    const managedKeys = metrics.map((m) => m.metric_key);

    try {
      // Per-brand upserts: one api_value row per (brand, metric, window).
      for (const [key, agg] of byBrand) {
        const [rowOrg, brand] = key.split("|");
        if (rowOrg !== org) continue;
        for (const metric of metrics) {
          const value = resolveBrandValue(metric, agg);
          if (value == null) continue; // honest null — no source rows / not mappable
          const { error } = await db().rpc("apply_metric_api_value", {
            p_org_id: org,
            p_metric_key: metric.metric_key,
            p_brand_id: brand,
            p_period_start: win.startDate,
            p_period_end: win.endDate,
            p_api_value: value,
          });
          if (error) {
            anyError = true;
            warnings.push(
              `org ${org} brand ${brand} ${metric.metric_key}: apply failed: ${JSON.stringify(error)}`
            );
            continue;
          }
          rowsUpserted += 1;
          brandsWritten.add(key);
        }
      }

      // Replace the old org-wide roll-up: drop any api-origin, tiktok_shop,
      // brand-NULL row for a managed key that OVERLAPS the window (row.start <=
      // win.end AND row.end >= win.start). manual_value IS NULL keeps a human
      // floor safe; archived_at IS NULL keeps the delete out of archived history.
      // Gated on real landed data so an empty sync never wipes a good roll-up.
      if (orgsWithData.has(org)) {
        const del = await db()
          .from("metric_entries")
          .delete()
          .eq("org_id", org)
          .is("brand_id", null)
          .eq("marketplace", "tiktok_shop")
          .eq("origin", "api")
          .is("manual_value", null)
          .is("archived_at", null)
          .in("metric_key", managedKeys)
          .lte("period_start", win.endDate)
          .gte("period_end", win.startDate)
          .select("id");
        if (del.error) {
          anyError = true;
          warnings.push(`org ${org}: supersede org-wide rows failed: ${JSON.stringify(del.error)}`);
        } else {
          supersededOrgRows += (del.data ?? []).length;
        }
      }

      console.info("[tiktok] metric_entries per-brand", {
        org,
        window: [win.startDate, win.endDate],
        metrics: managedKeys.length,
      });
    } catch (e) {
      anyError = true;
      const message = e instanceof Error ? e.message : String(e);
      warnings.push(`org ${org}: ${message}`);
      console.error("[tiktok] metric_entries per-brand org failed", { org, message });
    }
  }

  return {
    status: anyError ? "error" : "success",
    orgs: orgs.length,
    brands: brandsWritten.size,
    rowsUpserted,
    supersededOrgRows,
    skippedNullBrandRows,
    warnings,
  };
}
