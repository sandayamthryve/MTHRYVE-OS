import { createServiceRoleClient } from "@/lib/supabase/service";
import { aggregate, type BpmRow, BPM_COLUMNS } from "@/lib/metrics/gmv";
import { customWindow } from "@/lib/metrics/windows";

// The TikTok Shop RECONCILE step — folds landed per-shop daily data up to
// per-BRAND daily rows in brand_platform_metrics.
//
// ⚠️ DEPRECATED-FOR-READS TARGET (PR 3): brand_platform_metrics is no longer read
// by any commerce surface — every dashboard now reads the LIVE
// tiktok_shop_performance directly through lib/metrics/gmv (fetchCommerceRows) and
// lib/metrics/tiktok-live. This writer is KEPT (the table is intentionally not
// dropped) so brand_platform_metrics retains a per-brand audit/history trail and
// its self-verify still proves the fold is exact, but nothing new should READ the
// table it writes. See docs/INTEGRATION_PLAN.md.
//
// WHY a separate step: the daily sync lands raw per-shop daily rows in
// tiktok_shop_performance / tiktok_settlements. Reconcile folds the per-shop daily
// rows up to per-BRAND daily rows and writes them into brand_platform_metrics as the
// platform='tiktok_shop', source='tiktok_api' rows (the historical/audit record).
//
// SOURCE OF TRUTH: tiktok_shop_performance is authoritative for the ENTIRE
// tiktok_shop platform. So for every org we reconcile, any PRE-EXISTING
// brand_platform_metrics tiktok_shop row whose source is NOT 'tiktok_api' and
// which overlaps the reconciled window is SUPERSEDED (deleted). Without that,
// gmv.ts's per-(brand,platform) overlap collapse could keep a stale manual/import
// row over the live daily rows (or mix them), so the same GMV would be counted
// from the wrong source. Deleting the overlaps leaves a clean set of daily
// tiktok_api rows, which collapse trivially and reconcile by construction.
//
// IDEMPOTENT: each run first deletes this window's tiktok_api tiktok_shop rows
// for the org, then re-inserts them from the current landed data — so re-running
// a day overwrites rather than duplicates. (We delete+insert rather than upsert
// because uq_bpm_tiktok_api_daily is a PARTIAL unique index; PostgREST's
// .upsert({onConflict}) emits only the conflict columns, never the index's
// `WHERE source='tiktok_api'` predicate, so PostgreSQL cannot infer it as the
// arbiter. The delete we must run for supersession anyway makes insert the
// natural, index-safe idempotent path.)
//
// VERIFY: for each org the summary asserts the invariant the task requires —
// org tiktok_shop GMV (read back through gmv.ts) == the sum of per-brand
// tiktok_shop GMV == the tiktok_shop_performance total for the window.

// A cent of float tolerance — numeric(14,2) sums should match exactly, but
// Number addition can drift sub-cent.
const EPSILON = 0.01;

// --- Public shapes ----------------------------------------------------------

export interface ReconcileWindow {
  startDate: string; // inclusive YYYY-MM-DD (Asia/Manila calendar day)
  endDate: string; // inclusive YYYY-MM-DD
}

// Per-org proof that the numbers line up (surfaced in the run summary + logs).
export interface OrgReconciliation {
  orgId: string;
  brands: number; // distinct brands written
  rowsUpserted: number; // tiktok_api daily rows written
  superseded: number; // non-tiktok_api tiktok_shop rows deleted in-window
  gmvShopPerf: number; // Σ tiktok_shop_performance gmv (brand-attributed) in window
  gmvOrg: number; // org tiktok_shop gmv read back via gmv.ts aggregate
  gmvSumBrands: number; // Σ per-brand tiktok_shop gmv via gmv.ts aggregate
  skippedNullBrandGmv: number; // gmv on shop rows with no brand mapping (not writable)
  reconciled: boolean; // all three GMV figures agree within EPSILON
}

export interface ReconcileResult {
  status: "success" | "error";
  orgs: number; // orgs reconciled (had shop-performance data in window)
  rowsUpserted: number; // total tiktok_api rows written across orgs
  superseded: number; // total non-tiktok_api rows superseded across orgs
  reconciledOrgs: number; // orgs passing the invariant
  window: ReconcileWindow;
  orgResults: OrgReconciliation[];
  warnings: string[]; // mismatches + unmapped-brand notes (never silently dropped)
  error?: string;
}

// --- Minimal typed DB surface (service role; tiktok_* tables aren't in the
// generated Database type, so we describe just the query shapes we use — no
// `any`, mirroring lib/tiktok/sync.ts). ------------------------------------

interface FilterBuilder<Row> extends Promise<{ data: Row[] | null; error: unknown }> {
  select(cols: string): FilterBuilder<Row>;
  eq(col: string, val: string): FilterBuilder<Row>;
  neq(col: string, val: string): FilterBuilder<Row>;
  gte(col: string, val: string): FilterBuilder<Row>;
  lte(col: string, val: string): FilterBuilder<Row>;
}
interface TableApi {
  select(cols: string): FilterBuilder<Record<string, unknown>>;
  insert(rows: Record<string, unknown>[]): FilterBuilder<{ id: string }>;
  delete(): FilterBuilder<{ id: string }>;
}
interface ReconcileDb {
  from(table: string): TableApi;
}

function db(): ReconcileDb {
  return createServiceRoleClient() as unknown as ReconcileDb;
}

// --- Small helpers ----------------------------------------------------------

// Coerce a Postgres numeric (returned as a string) / integer to a finite number.
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

const orgBrandDayKey = (org: string, brand: string, day: string) => `${org}|${brand}|${day}`;

// --- Run log ----------------------------------------------------------------

// One tiktok_sync_runs row per reconciled org (endpoint='reconcile', shop_id
// null — this is an org-level roll-up, not a per-shop step). Best-effort: a
// logging failure is logged, never propagated.
async function writeReconcileRun(row: {
  orgId: string;
  window: ReconcileWindow;
  status: string;
  rows: number;
  error?: string | null;
  startedAt: string;
}): Promise<void> {
  try {
    const { error } = await db()
      .from("tiktok_sync_runs")
      .insert([
        {
          org_id: row.orgId,
          shop_id: null,
          endpoint: "reconcile",
          window_start: row.window.startDate,
          window_end: row.window.endDate,
          status: row.status,
          rows_upserted: row.rows,
          error_message: row.error ?? null,
          started_at: row.startedAt,
          finished_at: new Date().toISOString(),
        },
      ]);
    if (error) console.error("[tiktok] writeReconcileRun failed", error);
  } catch (e) {
    console.error("[tiktok] writeReconcileRun threw", e);
  }
}

// --- Landed-data readers ----------------------------------------------------

interface ShopPerfAgg {
  gmv: number;
  orders: number;
  units: number;
}

// Sum tiktok_shop_performance across a brand's shops → per (org, brand, day)
// commerce totals. Rows with no brand mapping are counted only as a per-org
// "skipped GMV" figure (they can't become brand_platform_metrics rows, which
// require a brand_id) so the shortfall is visible, never silently dropped.
async function loadShopPerformance(
  win: ReconcileWindow,
  orgId?: string
): Promise<{
  byBrandDay: Map<string, ShopPerfAgg>; // key = org|brand|day
  gmvByOrg: Map<string, number>; // Σ brand-attributed gmv per org
  brandsByOrg: Map<string, Set<string>>;
  skippedNullBrandGmvByOrg: Map<string, number>;
  orgsWithData: Set<string>;
}> {
  let q = db()
    .from("tiktok_shop_performance")
    .select("org_id, brand_id, stat_date, gmv, orders, units")
    .gte("stat_date", win.startDate)
    .lte("stat_date", win.endDate);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q;
  if (error) throw new Error(`load tiktok_shop_performance failed: ${JSON.stringify(error)}`);

  const byBrandDay = new Map<string, ShopPerfAgg>();
  const gmvByOrg = new Map<string, number>();
  const brandsByOrg = new Map<string, Set<string>>();
  const skippedNullBrandGmvByOrg = new Map<string, number>();
  const orgsWithData = new Set<string>();

  for (const r of data ?? []) {
    const org = str(r.org_id);
    const day = str(r.stat_date);
    if (!org || !day) continue;
    const gmv = num(r.gmv);
    const brand = str(r.brand_id);
    if (!brand) {
      skippedNullBrandGmvByOrg.set(org, (skippedNullBrandGmvByOrg.get(org) ?? 0) + gmv);
      continue;
    }
    orgsWithData.add(org);
    const key = orgBrandDayKey(org, brand, day);
    const agg = byBrandDay.get(key) ?? { gmv: 0, orders: 0, units: 0 };
    agg.gmv += gmv;
    agg.orders += num(r.orders);
    agg.units += num(r.units);
    byBrandDay.set(key, agg);
    gmvByOrg.set(org, (gmvByOrg.get(org) ?? 0) + gmv);
    const set = brandsByOrg.get(org) ?? new Set<string>();
    set.add(brand);
    brandsByOrg.set(org, set);
  }

  return { byBrandDay, gmvByOrg, brandsByOrg, skippedNullBrandGmvByOrg, orgsWithData };
}

// Fold settlement refunds up to per (org, brand, day). We store a monetary
// return RATE (refund ÷ gmv) on the matching daily row so the number reflects
// TikTok's own refund figure; GMV itself is left untouched (tiktok_shop_
// performance is the source of truth for GMV, and the reconcile invariant must
// hold on it). tiktok_settlements carries only refund AMOUNTS, not a return
// COUNT, so the integer `returns` column is left null rather than filled with a
// value that isn't a count.
async function loadSettlementRefunds(
  win: ReconcileWindow,
  orgId?: string
): Promise<Map<string, number>> {
  let q = db()
    .from("tiktok_settlements")
    .select("org_id, brand_id, stat_date, refund_amount")
    .gte("stat_date", win.startDate)
    .lte("stat_date", win.endDate);
  if (orgId) q = q.eq("org_id", orgId);
  const { data, error } = await q;
  if (error) throw new Error(`load tiktok_settlements failed: ${JSON.stringify(error)}`);

  const refundByBrandDay = new Map<string, number>();
  for (const r of data ?? []) {
    const org = str(r.org_id);
    const brand = str(r.brand_id);
    const day = str(r.stat_date);
    if (!org || !brand || !day) continue;
    const key = orgBrandDayKey(org, brand, day);
    // Refund amounts are typically negative adjustments; use the magnitude.
    refundByBrandDay.set(key, (refundByBrandDay.get(key) ?? 0) + Math.abs(num(r.refund_amount)));
  }
  return refundByBrandDay;
}

// --- Per-org reconcile ------------------------------------------------------

// Insert in modest chunks so a large backfill (?days=90) stays under any
// row-count limits.
const INSERT_CHUNK = 500;

async function insertRows(rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const { error } = await db().from("brand_platform_metrics").insert(chunk);
    if (error) throw new Error(`insert brand_platform_metrics failed: ${JSON.stringify(error)}`);
  }
}

// Fetch this org's stored tiktok_shop rows back and aggregate them with gmv.ts's
// pure collapse — proving what we WROTE into brand_platform_metrics sums to the
// tiktok_shop_performance total, not just that rows were written. (Dashboards no
// longer read brand_platform_metrics; this stays a write-integrity check on the
// audit table.)
async function verifyOrg(
  orgId: string,
  win: ReconcileWindow
): Promise<{ gmvOrg: number; gmvSumBrands: number }> {
  const { data, error } = await db()
    .from("brand_platform_metrics")
    .select(BPM_COLUMNS)
    .eq("org_id", orgId)
    .eq("platform", "tiktok_shop");
  if (error) throw new Error(`verify read failed: ${JSON.stringify(error)}`);
  const rows = (data ?? []) as unknown as BpmRow[];
  const window = customWindow(win.startDate, win.endDate, "reconcile");
  const gmvOrg = aggregate(rows, window, { platform: "tiktok_shop" }).gmv;
  const brandIds = new Set(rows.map((r) => r.brand_id));
  let gmvSumBrands = 0;
  for (const id of brandIds) {
    gmvSumBrands += aggregate(rows, window, { brandId: id, platform: "tiktok_shop" }).gmv;
  }
  return { gmvOrg, gmvSumBrands };
}

// --- Orchestrator -----------------------------------------------------------

// Reconcile TikTok Shop landed data into brand_platform_metrics for a window,
// optionally scoped to one org (the manual/end-of-sync path) or all orgs with
// data (the cron path). Never throws for a single org — each org is isolated and
// logged, so one org's failure can't abort the rest.
export async function reconcileTikTok(opts: {
  orgId?: string;
  window: ReconcileWindow;
}): Promise<ReconcileResult> {
  const { orgId, window: win } = opts;
  const warnings: string[] = [];

  const perf = await loadShopPerformance(win, orgId);
  const refunds = await loadSettlementRefunds(win, orgId);

  const orgResults: OrgReconciliation[] = [];
  let totalRows = 0;
  let totalSuperseded = 0;
  let reconciledOrgs = 0;
  let anyError = false;

  const orgs = Array.from(perf.orgsWithData).sort();
  for (const org of orgs) {
    const startedAt = new Date().toISOString();
    const brandIds = perf.brandsByOrg.get(org) ?? new Set<string>();
    const skippedNullBrandGmv = perf.skippedNullBrandGmvByOrg.get(org) ?? 0;
    const gmvShopPerf = perf.gmvByOrg.get(org) ?? 0;

    try {
      // Build this org's fresh daily rows from the landed shop data.
      const rows: Record<string, unknown>[] = [];
      for (const [key, agg] of perf.byBrandDay) {
        const [rowOrg, brand, day] = key.split("|");
        if (rowOrg !== org) continue;
        const refund = refunds.get(key) ?? 0;
        const returnRate = agg.gmv > 0 && refund > 0 ? Math.min(refund / agg.gmv, 9.9999) : null;
        rows.push({
          org_id: org,
          brand_id: brand,
          platform: "tiktok_shop",
          period_start: day,
          period_end: day,
          gmv: agg.gmv,
          orders: agg.orders,
          units: agg.units,
          return_rate: returnRate,
          source: "tiktok_api",
          currency: "PHP",
        });
      }

      // 1) Idempotent refresh: drop this window's existing tiktok_api tiktok_shop
      //    rows for the org (period_start/end are the same day, both in-window).
      const delApi = await db()
        .from("brand_platform_metrics")
        .delete()
        .eq("org_id", org)
        .eq("platform", "tiktok_shop")
        .eq("source", "tiktok_api")
        .gte("period_start", win.startDate)
        .lte("period_end", win.endDate)
        .select("id");
      if (delApi.error) {
        throw new Error(`delete stale tiktok_api rows failed: ${JSON.stringify(delApi.error)}`);
      }

      // 2) Supersede: drop any non-tiktok_api tiktok_shop row that OVERLAPS the
      //    window (row.period_start <= end AND row.period_end >= start). This is
      //    what keeps gmv.ts from ever counting the same tiktok_shop GMV from a
      //    stale source alongside the live daily rows.
      const delStale = await db()
        .from("brand_platform_metrics")
        .delete()
        .eq("org_id", org)
        .eq("platform", "tiktok_shop")
        .neq("source", "tiktok_api")
        .lte("period_start", win.endDate)
        .gte("period_end", win.startDate)
        .select("id");
      if (delStale.error) {
        throw new Error(`supersede non-tiktok_api rows failed: ${JSON.stringify(delStale.error)}`);
      }
      const superseded = (delStale.data ?? []).length;

      // 3) Write the fresh authoritative rows.
      await insertRows(rows);

      // 4) Verify through gmv.ts: org total == Σ per-brand == shop-performance total.
      const { gmvOrg, gmvSumBrands } = await verifyOrg(org, win);
      const reconciled =
        Math.abs(gmvOrg - gmvShopPerf) <= EPSILON && Math.abs(gmvOrg - gmvSumBrands) <= EPSILON;

      const result: OrgReconciliation = {
        orgId: org,
        brands: brandIds.size,
        rowsUpserted: rows.length,
        superseded,
        gmvShopPerf,
        gmvOrg,
        gmvSumBrands,
        skippedNullBrandGmv,
        reconciled,
      };
      orgResults.push(result);
      totalRows += rows.length;
      totalSuperseded += superseded;

      if (reconciled) reconciledOrgs += 1;
      else {
        anyError = true;
        warnings.push(
          `org ${org}: GMV mismatch — shopPerf=${gmvShopPerf.toFixed(2)} ` +
            `org=${gmvOrg.toFixed(2)} sumBrands=${gmvSumBrands.toFixed(2)}`
        );
      }
      if (skippedNullBrandGmv > EPSILON) {
        warnings.push(
          `org ${org}: ${skippedNullBrandGmv.toFixed(2)} GMV on shops with no brand mapping ` +
            `was not reconciled (no brand_id)`
        );
      }

      await writeReconcileRun({
        orgId: org,
        window: win,
        status: reconciled ? "success" : "error",
        rows: rows.length,
        error: reconciled ? null : warnings[warnings.length - 1] ?? "gmv mismatch",
        startedAt,
      });
      console.info("[tiktok] reconcile org", {
        org,
        rows: rows.length,
        superseded,
        reconciled,
        gmvShopPerf,
        gmvOrg,
      });
    } catch (e) {
      anyError = true;
      const message = e instanceof Error ? e.message : String(e);
      warnings.push(`org ${org}: ${message}`);
      await writeReconcileRun({
        orgId: org,
        window: win,
        status: "error",
        rows: 0,
        error: message,
        startedAt,
      });
      console.error("[tiktok] reconcile org failed", { org, message });
    }
  }

  return {
    status: anyError ? "error" : "success",
    orgs: orgs.length,
    rowsUpserted: totalRows,
    superseded: totalSuperseded,
    reconciledOrgs,
    window: win,
    orgResults,
    warnings,
  };
}
