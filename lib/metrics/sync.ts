// lib/metrics/sync.ts — the API VALIDATION OVERLAY sync (Phase 2, Part A).
//
// WHAT IT DOES: for one org and ONE requested period, read metric_catalog for
// the auto / auto_possible metrics, pull the REAL number from each metric's
// mapped source table, and write it to metric_entries.api_value — and ONLY
// api_value. The Phase-1 trigger then derives variance_pct + validation_status.
//
// THE FOUR NON-NEGOTIABLES, enforced here:
//   1. api_value only. Every write goes through the apply_metric_api_value()
//      DB function, whose body cannot assign manual_value. There is no code path
//      in this file that writes manual_value.
//   2. No fabricated data. A source that returns NO rows for the period leaves
//      api_value null (the metric is skipped). Only a real returned number is
//      written — a genuine 0 (rows exist, they sum to 0) IS written; "no rows"
//      is NOT.
//   3. Service-role stays server-side. This module imports the service-role
//      client and is only ever called from the /api/metrics/sync route handler.
//   4. A mismatch is surfaced, never auto-resolved. variance > 15% opens a
//      PENDING action_request; nothing here flips a status to resolved.
//
// NO BACKFILL: the caller passes exactly one [startDate, endDate]; this module
// touches only that window. It never widens the range (protects the audit GMV
// baseline).

import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import { notifyMetricMismatch } from "@/lib/notifications/producers";

// The provisioned tables this sync reads/writes (tiktok_*, shop_*, metric_*,
// action_requests) aren't in the generated Database types, so — exactly like
// lib/tiktok/reconcile.ts — we drive the service-role client through a loose
// query-builder shim rather than fighting the strict generated overloads.
interface QueryBuilder extends Promise<{ data: any; error: any }> {
  select(cols?: string): QueryBuilder;
  insert(v: Record<string, unknown>): QueryBuilder;
  update(v: Record<string, unknown>): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  is(col: string, val: unknown): QueryBuilder;
  not(col: string, op: string, val: unknown): QueryBuilder;
  gte(col: string, val: unknown): QueryBuilder;
  lte(col: string, val: unknown): QueryBuilder;
  order(col: string, opts?: { ascending: boolean }): QueryBuilder;
  limit(n: number): QueryBuilder;
  single(): QueryBuilder;
  maybeSingle(): QueryBuilder;
}
interface Db {
  from(table: string): QueryBuilder;
  rpc(fn: string, params: Record<string, unknown>): Promise<{ error: any }>;
}

export interface SyncWindow {
  startDate: string; // inclusive YYYY-MM-DD
  endDate: string; // inclusive YYYY-MM-DD
}

interface CatalogRow {
  metric_key: string;
  label: string;
  lane: string;
  api_source: string;
  api_field: string;
}

export interface OrgSyncResult {
  org_id: string;
  period: { start: string; end: string };
  catalog_metrics: number;
  applied: Array<{ metric_key: string; api_value: number }>;
  skipped: Array<{ metric_key: string; reason: string }>;
  mismatches: Array<{
    metric_key: string;
    label: string;
    manual_value: number | null;
    api_value: number | null;
    variance_pct: number | null;
  }>;
  escalated: Array<{ metric_key: string; action_request_id: string }>;
}

export interface SyncResult {
  status: "success";
  orgs: number;
  results: OrgSyncResult[];
}

// The variance that trips a human review escalation (Part B).
const ESCALATION_THRESHOLD_PCT = 15;

// ── Source pulls ─────────────────────────────────────────────────────────────
// Each returns { hadRows, ...aggregates }. hadRows=false ⇒ the source had NO
// data for the period, so every metric mapped to it is skipped (null, "—").

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function pullShopPerformance(db: Db, orgId: string, w: SyncWindow) {
  // Daily rows (stat_date) aggregated by org + period.
  const { data } = await db
    .from("tiktok_shop_performance")
    .select("gmv, orders, units, visitors, page_views")
    .eq("org_id", orgId)
    .gte("stat_date", w.startDate)
    .lte("stat_date", w.endDate);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const agg = rows.reduce<{
    gmv: number;
    orders: number;
    units: number;
    visitors: number;
    page_views: number;
  }>(
    (a, r) => ({
      gmv: a.gmv + num(r.gmv),
      orders: a.orders + num(r.orders),
      units: a.units + num(r.units),
      visitors: a.visitors + num(r.visitors),
      page_views: a.page_views + num(r.page_views),
    }),
    { gmv: 0, orders: 0, units: 0, visitors: 0, page_views: 0 }
  );
  // Conversion is a RATE — derive it from the period totals, never average
  // daily rates (that would weight a slow day the same as a busy one).
  const conversion_rate = agg.visitors > 0 ? agg.orders / agg.visitors : 0;
  return { hadRows: rows.length > 0, ...agg, conversion_rate };
}

async function pullSettlements(db: Db, orgId: string, w: SyncWindow) {
  const { data } = await db
    .from("tiktok_settlements")
    .select("net_amount, refund_amount")
    .eq("org_id", orgId)
    .gte("stat_date", w.startDate)
    .lte("stat_date", w.endDate);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const agg = rows.reduce<{ net_amount: number; refund_amount: number }>(
    (a, r) => ({
      net_amount: a.net_amount + num(r.net_amount),
      refund_amount: a.refund_amount + num(r.refund_amount),
    }),
    { net_amount: 0, refund_amount: 0 }
  );
  return { hadRows: rows.length > 0, ...agg };
}

async function pullProduct(db: Db, orgId: string, w: SyncWindow) {
  const { data } = await db
    .from("tiktok_product_performance")
    .select("gmv")
    .eq("org_id", orgId)
    .gte("stat_date", w.startDate)
    .lte("stat_date", w.endDate);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const gmv = rows.reduce((a, r) => a + num(r.gmv), 0);
  return { hadRows: rows.length > 0, gmv };
}

async function pullAds(db: Db, orgId: string, w: SyncWindow) {
  // shop_ads carries its OWN period_start/period_end — take rows overlapping the
  // requested window.
  const { data } = await db
    .from("shop_ads")
    .select("cost")
    .eq("org_id", orgId)
    .lte("period_start", w.endDate)
    .gte("period_end", w.startDate);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const cost = rows.reduce((a, r) => a + num(r.cost), 0);
  return { hadRows: rows.length > 0, cost };
}

async function pullRatings(db: Db, orgId: string, w: SyncWindow) {
  const { data } = await db
    .from("shop_ratings")
    .select("shop_rating")
    .eq("org_id", orgId)
    .lte("period_start", w.endDate)
    .gte("period_end", w.startDate);
  const rows = (data ?? []) as Array<{ shop_rating: unknown }>;
  const rated = rows.map((r) => num(r.shop_rating)).filter((n) => n > 0);
  const shop_rating = rated.length > 0 ? rated.reduce((a, b) => a + b, 0) / rated.length : 0;
  return { hadRows: rated.length > 0, shop_rating };
}

// Map a catalog metric to its real number, or null when its source had no rows.
function resolveValue(
  metric: CatalogRow,
  sources: {
    shop: Awaited<ReturnType<typeof pullShopPerformance>>;
    settle: Awaited<ReturnType<typeof pullSettlements>>;
    product: Awaited<ReturnType<typeof pullProduct>>;
    ads: Awaited<ReturnType<typeof pullAds>>;
    ratings: Awaited<ReturnType<typeof pullRatings>>;
  }
): number | null {
  switch (metric.api_source) {
    case "tiktok_shop": {
      if (!sources.shop.hadRows) return null;
      const s = sources.shop as unknown as Record<string, number>;
      return metric.api_field in s ? s[metric.api_field] : null;
    }
    case "tiktok_settlement": {
      if (!sources.settle.hadRows) return null;
      const s = sources.settle as unknown as Record<string, number>;
      return metric.api_field in s ? s[metric.api_field] : null;
    }
    case "product":
      if (!sources.product.hadRows) return null;
      return metric.api_field === "gmv" ? sources.product.gmv : null;
    case "ads":
      if (!sources.ads.hadRows) return null;
      return metric.api_field === "cost" ? sources.ads.cost : null;
    case "ratings":
      if (!sources.ratings.hadRows) return null;
      return metric.api_field === "shop_rating" ? sources.ratings.shop_rating : null;
    default:
      return null;
  }
}

// ── Escalation (Part B) ──────────────────────────────────────────────────────
// A resulting mismatch whose |variance| > 15% opens a PENDING action_request so
// a human reconciles it. Idempotent: an open request for the same metric+period
// is never duplicated.

async function escalateMismatches(
  db: Db,
  orgId: string,
  w: SyncWindow,
  mismatches: OrgSyncResult["mismatches"]
): Promise<OrgSyncResult["escalated"]> {
  const escalated: OrgSyncResult["escalated"] = [];
  const toEscalate = mismatches.filter(
    (m) => m.variance_pct != null && Math.abs(m.variance_pct) > ESCALATION_THRESHOLD_PCT
  );
  if (toEscalate.length === 0) return escalated;

  // Existing OPEN metric-mismatch requests → their (metric_key|period) keys.
  const { data: openRows } = await db
    .from("action_requests")
    .select("source_ref, status")
    .eq("org_id", orgId)
    .eq("source_module", "metric_reconciliation")
    .in("status", ["pending", "approved"]);
  const openKeys = new Set<string>();
  for (const r of (openRows ?? []) as Array<{ source_ref: Record<string, unknown> | null }>) {
    const sr = r.source_ref ?? {};
    const k = `${sr.metric_key}|${sr.period_start}|${sr.period_end}`;
    openKeys.add(k);
  }

  for (const m of toEscalate) {
    const key = `${m.metric_key}|${w.startDate}|${w.endDate}`;
    if (openKeys.has(key)) continue;

    const period = `${w.startDate} → ${w.endDate}`;
    const { data: inserted, error } = await db
      .from("action_requests")
      .insert({
        org_id: orgId,
        created_by: null,
        source_module: "metric_reconciliation",
        source_ref: {
          metric_key: m.metric_key,
          brand_id: null,
          period_start: w.startDate,
          period_end: w.endDate,
          variance_pct: m.variance_pct,
        },
        title: `Metric mismatch: ${m.label} ${period}`,
        problem:
          `The platform API value (${m.api_value}) differs from the recorded manual value ` +
          `(${m.manual_value}) by ${m.variance_pct}% for ${m.label} over ${period}. ` +
          `A gap this large needs a human to reconcile before the number is trusted.`,
        root_cause: null,
        evidence: [
          { label: "Manual", value: String(m.manual_value) },
          { label: "API", value: String(m.api_value) },
          { label: "Variance", value: `${m.variance_pct}%` },
        ],
        recommendation:
          "Reconcile on the Validation panel — keep the manual figure, accept the API figure, or override with the correct number.",
        risk_tier: 2,
        required_role: "coo",
        status: "pending",
      })
      .select("id")
      .single();
    if (error || !(inserted as { id?: string } | null)?.id) continue;
    const id = (inserted as { id: string }).id;
    openKeys.add(key);
    await writeActionAudit(db as unknown as { from: (t: string) => any }, {
      org_id: orgId,
      action_request_id: id,
      event: "created",
      actor_id: null,
      actor_role: "system",
      detail: { source: "metrics_sync", metric_key: m.metric_key, variance_pct: m.variance_pct },
    });

    // Tell leadership the number isn't trusted until reconciled — points at the
    // reconciliation request. Best-effort; a failed notify never breaks the sync.
    await notifyMetricMismatch(
      {
        orgId,
        metricLabel: m.label,
        variancePct: m.variance_pct,
        period,
        actionRequestId: id,
      },
      db as unknown as { from: (t: string) => any }
    );

    escalated.push({ metric_key: m.metric_key, action_request_id: id });
  }
  return escalated;
}

// ── One org, one period ──────────────────────────────────────────────────────
async function syncOrg(db: Db, orgId: string, w: SyncWindow): Promise<OrgSyncResult> {
  const result: OrgSyncResult = {
    org_id: orgId,
    period: { start: w.startDate, end: w.endDate },
    catalog_metrics: 0,
    applied: [],
    skipped: [],
    mismatches: [],
    escalated: [],
  };

  // 1. The auto / auto_possible catalog, as required by the spec.
  const { data: catData } = await db
    .from("metric_catalog")
    .select("metric_key, label, lane, api_source, api_field")
    .eq("org_id", orgId)
    .in("lane", ["auto", "auto_possible"])
    .not("api_source", "is", null);
  const catalog = (catData ?? []) as unknown as CatalogRow[];
  result.catalog_metrics = catalog.length;
  if (catalog.length === 0) return result;

  // 2. Pull every mapped source ONCE for the window.
  const [shop, settle, product, ads, ratings] = await Promise.all([
    pullShopPerformance(db, orgId, w),
    pullSettlements(db, orgId, w),
    pullProduct(db, orgId, w),
    pullAds(db, orgId, w),
    pullRatings(db, orgId, w),
  ]);
  const sources = { shop, settle, product, ads, ratings };

  // 3. Apply api_value (only) for every metric with a real number.
  for (const metric of catalog) {
    const value = resolveValue(metric, sources);
    if (value == null) {
      result.skipped.push({ metric_key: metric.metric_key, reason: "no source rows for period" });
      continue;
    }
    const { error } = await db.rpc("apply_metric_api_value", {
      p_org_id: orgId,
      p_metric_key: metric.metric_key,
      p_brand_id: null,
      p_period_start: w.startDate,
      p_period_end: w.endDate,
      p_api_value: value,
    });
    if (error) {
      result.skipped.push({ metric_key: metric.metric_key, reason: `apply failed: ${error.message}` });
      continue;
    }
    result.applied.push({ metric_key: metric.metric_key, api_value: value });
  }

  // 4. Read back this window's entries — the trigger has set variance_pct +
  //    validation_status. Collect the mismatches for escalation + the response.
  const { data: entries } = await db
    .from("metric_entries")
    .select("metric_key, manual_value, api_value, variance_pct, validation_status")
    .eq("org_id", orgId)
    .is("brand_id", null)
    // AI-spine guardrail: this readback feeds mismatch escalation into pending
    // action_requests (a decision surface), and runs on the service-role client
    // (no RLS) — so the exclusion MUST be explicit. A soft-archived metric must
    // never generate an escalation. Fail closed.
    .is("archived_at", null)
    .eq("period_start", w.startDate)
    .eq("period_end", w.endDate)
    .eq("validation_status", "mismatch");
  const labelByKey = new Map(catalog.map((c) => [c.metric_key, c.label]));
  result.mismatches = ((entries ?? []) as Array<Record<string, unknown>>).map((e) => ({
    metric_key: String(e.metric_key),
    label: labelByKey.get(String(e.metric_key)) ?? String(e.metric_key),
    manual_value: e.manual_value == null ? null : num(e.manual_value),
    api_value: e.api_value == null ? null : num(e.api_value),
    variance_pct: e.variance_pct == null ? null : num(e.variance_pct),
  }));

  // 5. Escalate the > 15% gaps to a pending action_request.
  result.escalated = await escalateMismatches(db, orgId, w, result.mismatches);

  return result;
}

// ── Public entry ─────────────────────────────────────────────────────────────
// orgId set → that org only (leadership path). orgId undefined → every org
// (cron path). Always exactly the passed window — no backfill.
export async function syncMetrics(opts: {
  orgId?: string;
  window: SyncWindow;
}): Promise<SyncResult> {
  const db = createServiceRoleClient() as unknown as Db;

  let orgIds: string[];
  if (opts.orgId) {
    orgIds = [opts.orgId];
  } else {
    const { data } = await db.from("organizations").select("id");
    orgIds = ((data ?? []) as Array<{ id: string }>).map((o) => o.id);
  }

  const results: OrgSyncResult[] = [];
  for (const orgId of orgIds) {
    results.push(await syncOrg(db, orgId, opts.window));
  }
  return { status: "success", orgs: results.length, results };
}
