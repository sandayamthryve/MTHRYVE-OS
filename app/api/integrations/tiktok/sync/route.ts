import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import {
  automationApiKey,
  cronSecret,
  isTikTokConfigured,
  tiktokSyncWindowDays,
} from "@/lib/tiktok/config";
import {
  listShopsForSync,
  getValidAccessToken,
  resolveWindow,
  writeSyncRun,
  writeSyncRunSummary,
  classifyRun,
  isAuthFailure,
  syncOrders,
  syncSettlements,
  syncShopPerformance,
  syncProductPerformance,
  type EndpointName,
  type EndpointResult,
  type SyncShop,
  type SyncWindow,
  type SyncRunAccumulator,
} from "@/lib/tiktok/sync";
import { refreshExpiringConnections, type ProactiveRefreshSummary } from "@/lib/tiktok/vault";
import { reconcileTikTok, type ReconcileResult } from "@/lib/tiktok/reconcile";
import { syncBrandMetricEntries, type BrandMetricEntriesResult } from "@/lib/tiktok/metric-entries";
import { writeAudit } from "@/lib/audit/log";

export const runtime = "nodejs";
// Read env fresh per request (Vercel "Sensitive" runtime-only vars) and never
// cache — this is a mutating sync, not a static read.
export const dynamic = "force-dynamic";
// A full multi-shop, multi-endpoint pull is I/O-heavy; give it room.
export const maxDuration = 300;

// POST/GET /api/integrations/tiktok/sync — the daily TikTok Shop READ-sync.
//
// Two ways in:
//   • A MACHINE trigger sends `Authorization: Bearer <secret>` and runs across
//     ALL orgs' shops. The secret may be CRON_SECRET (Vercel Cron) OR
//     AUTOMATION_API_KEY (the GitHub Actions schedule — our reliable daily driver, since
//     Vercel Hobby cron is best-effort). Both are server-side machine secrets and
//     are compared in constant time.
//   • A leadership "Sync now" click POSTs with the user's session — runs the
//     caller's org only. (When no machine secret is set, only this path works.)
// Anything else is rejected 401.
//
// WINDOW: by default the sync pulls a ROLLING window ending yesterday, in
// Asia/Manila. The default span is TIKTOK_SYNC_WINDOW_DAYS (30) so a full month of
// true daily rows is always landed instead of a sliver that forces extrapolation.
//   • ?days=N     — override the rolling span to N days.
//   • ?backfill=N — one-time BACKFILL: pull N days of full history per shop (e.g.
//                   ?backfill=90). Same idempotent upsert path as the daily sync,
//                   so re-running a backfill inserts 0 duplicates. `backfill` wins
//                   over `days` when both are present.
//
// TOKEN REFRESH is DECOUPLED from the data pull: before touching any shop's data
// we run a proactive pass that renews every connection whose access token is
// within TIKTOK_TOKEN_REFRESH_WINDOW_HOURS (48h) of expiry, using its stored
// refresh_token. A shop whose data pull keeps auth-failing therefore still gets
// its token renewed and un-sticks itself — the refresh no longer rides on a
// successful pull.
//
// Per (shop, endpoint) the work is wrapped so one failure NEVER aborts the loop:
// each step records a tiktok_sync_runs row (status/rows/error) and moves on.
// Analytics may be denied until its scope is granted — that logs the existing
// 'skipped: analytics scope pending' status (GMV/orders unaffected), NOT a failure
// and NOT a bogus "token expired". A genuine invalid/expired token still
// classifies auth_failed.
//
// READ ONLY. Daily AGGREGATES only — never any customer PII.

interface SyncSummary {
  shops: number;
  endpoints: number; // total (shop × endpoint) steps attempted
  upserted: number; // total landing rows upserted
  errors: string[];
  mode?: "daily" | "backfill"; // rolling daily sync vs one-time history backfill
  windowDays?: number; // the resolved span, in days
  tokenRefresh?: ProactiveRefreshSummary; // decoupled proactive token-refresh pass
  reconcile?: ReconcileResult; // final roll-up into brand_platform_metrics
  metricEntries?: BrandMetricEntriesResult; // per-brand ecom.* overlay in metric_entries
}

// Get-or-create the per-org run accumulator (the run-level tally we classify at
// the end). Keyed by org so a machine run across many orgs classifies each one.
function ensureOrgRun(
  orgRuns: Map<string, SyncRunAccumulator>,
  orgId: string,
  startedAt: string
): SyncRunAccumulator {
  let acc = orgRuns.get(orgId);
  if (!acc) {
    acc = { startedAt, steps: 0, successSteps: 0, upserted: 0, authFailure: false, errors: [] };
    orgRuns.set(orgId, acc);
  }
  return acc;
}

// Run one endpoint step in isolation: log a sync-run row either way, fold its
// rows into the summary AND the org run-tally, and record (never throw) any
// error. A step whose status begins with 'success' counts as a successful shop
// upsert; an auth/login response flips the org's authFailure flag.
async function runStep(
  shop: SyncShop,
  win: SyncWindow,
  endpoint: EndpointName,
  fn: () => Promise<EndpointResult>,
  summary: SyncSummary,
  acc: SyncRunAccumulator
): Promise<void> {
  const startedAt = new Date().toISOString();
  summary.endpoints += 1;
  acc.steps += 1;
  try {
    const result = await fn();
    summary.upserted += result.rows;
    acc.upserted += result.rows;
    if (result.status.startsWith("success")) acc.successSteps += 1;
    await writeSyncRun({
      org_id: shop.org_id,
      shop_id: shop.shop_id,
      endpoint,
      window: win,
      status: result.status,
      rows: result.rows,
      error: result.error,
      startedAt,
    });
    console.info("[tiktok] sync step", {
      shop: shop.shop_id,
      endpoint,
      status: result.status,
      rows: result.rows,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    summary.errors.push(`${shop.shop_id}/${endpoint}: ${message}`);
    acc.errors.push(`${shop.shop_id}/${endpoint}: ${message}`);
    if (isAuthFailure(e)) acc.authFailure = true;
    await writeSyncRun({
      org_id: shop.org_id,
      shop_id: shop.shop_id,
      endpoint,
      window: win,
      status: "error",
      rows: 0,
      error: message,
      startedAt,
    });
    console.error("[tiktok] sync step failed", { shop: shop.shop_id, endpoint, message });
  }
}

// Constant-time check that the Authorization header is `Bearer <expected>`.
function bearerMatches(authHeader: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const provided = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  // --- Auth: leadership session OR a machine bearer (cron OR GitHub Actions automation). ---
  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  const isMachine =
    bearerMatches(authHeader, cronSecret()) || bearerMatches(authHeader, automationApiKey());

  let orgScope: string | undefined;
  // The audit actor for the run: null/'system' for a machine trigger, the
  // leadership caller for a manual "Sync now".
  let actor: { id: string; role: string } | null = null;
  if (!isMachine) {
    const profile = await getSessionProfile();
    const leadership =
      profile?.role === "ceo" || profile?.role === "coo" || profile?.role === "department_head";
    if (!profile || !leadership) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // A manual run only touches the caller's own org.
    orgScope = profile.org_id;
    actor = { id: profile.id, role: profile.role };
  }

  if (!isTikTokConfigured()) {
    return NextResponse.json({ error: "tiktok_not_configured" }, { status: 503 });
  }

  // --- Window ---
  // Precedence: ?backfill=N (one-time full-history pull) > ?days=N (explicit
  // override) > TIKTOK_SYNC_WINDOW_DAYS (rolling default, 30). A backfill uses the
  // exact same idempotent upsert path as the daily sync — just a wider window.
  const params = new URL(request.url).searchParams;
  const backfillParam = params.get("backfill");
  const daysParam = params.get("days");
  const isBackfill = backfillParam !== null;
  // `?backfill` with no/invalid value means "full available history" — default to
  // 90 days. `?days` with an invalid value falls back to the rolling default.
  const parsedBackfill = Number(backfillParam);
  const parsedDays = Number(daysParam);
  const windowDays = isBackfill
    ? Number.isFinite(parsedBackfill) && parsedBackfill >= 1
      ? Math.floor(parsedBackfill)
      : 90
    : daysParam !== null && Number.isFinite(parsedDays) && parsedDays >= 1
      ? Math.floor(parsedDays)
      : tiktokSyncWindowDays();
  const win = resolveWindow(windowDays);
  console.info("[tiktok] sync start", {
    mode: isMachine ? "machine" : "manual",
    kind: isBackfill ? "backfill" : "daily",
    org: orgScope ?? "all",
    windowDays,
    window: [win.startDate, win.endDate],
  });

  const runStartedAt = new Date().toISOString();
  const summary: SyncSummary = {
    shops: 0,
    endpoints: 0,
    upserted: 0,
    errors: [],
    mode: isBackfill ? "backfill" : "daily",
    windowDays,
  };

  // --- Proactive token refresh (DECOUPLED from the data pull) ---
  // Renew any connection within the refresh window BEFORE pulling data, so a shop
  // whose data pull keeps auth-failing still gets its token rotated and un-sticks
  // itself. Best-effort: a refresh failure here is recorded in the summary but must
  // never abort the sync (the per-shop pull still runs and classifies as usual).
  try {
    summary.tokenRefresh = await refreshExpiringConnections(orgScope);
    console.info("[tiktok] proactive token refresh", {
      considered: summary.tokenRefresh.considered,
      refreshed: summary.tokenRefresh.refreshed,
      failed: summary.tokenRefresh.failed,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    summary.errors.push(`token_refresh: ${message}`);
    console.error("[tiktok] proactive token refresh threw", message);
  }

  const shops = await listShopsForSync(orgScope);
  summary.shops = shops.length;

  // Per-org run tally, classified into ONE run_summary row at the end so the
  // health monitor can read a single honest verdict per org. Only orgs that
  // actually had a shop to attempt get an entry — an org with no active shops
  // has nothing to sync and is deliberately not classified as failed.
  const orgRuns = new Map<string, SyncRunAccumulator>();

  for (const shop of shops) {
    const acc = ensureOrgRun(orgRuns, shop.org_id, runStartedAt);
    // One token per shop (auto-refreshed). If we can't get one, log a run row
    // per endpoint as an error and skip the shop rather than throwing. A shop
    // whose token can't be minted is an AUTH failure for the org — the same
    // class of problem as a login-HTML bounce.
    const token = await getValidAccessToken(shop.org_id, shop.open_id);
    if (!token) {
      acc.authFailure = true;
      const startedAt = new Date().toISOString();
      const endpoints: EndpointName[] = ["orders", "settlements", "shop_performance", "product_performance"];
      for (const endpoint of endpoints) {
        summary.endpoints += 1;
        acc.steps += 1;
        summary.errors.push(`${shop.shop_id}/${endpoint}: no valid access token`);
        acc.errors.push(`${shop.shop_id}/${endpoint}: no valid access token`);
        await writeSyncRun({
          org_id: shop.org_id,
          shop_id: shop.shop_id,
          endpoint,
          window: win,
          status: "error",
          rows: 0,
          error: "no valid access token",
          startedAt,
        });
      }
      console.error("[tiktok] sync: no token for shop", { shop: shop.shop_id });
      continue;
    }

    // 1) Orders → daily shop aggregate. 2) Settlements. 3a) Shop performance
    //    enrich. 3b) Product performance. Order matters: shop-performance
    //    enrich upserts onto the rows the orders step created.
    await runStep(shop, win, "orders", () => syncOrders(shop, token, win), summary, acc);
    await runStep(shop, win, "settlements", () => syncSettlements(shop, token, win), summary, acc);
    await runStep(shop, win, "shop_performance", () => syncShopPerformance(shop, token, win), summary, acc);
    await runStep(shop, win, "product_performance", () => syncProductPerformance(shop, token, win), summary, acc);
  }

  // FINAL STEP — roll the landed per-shop daily rows up into brand_platform_metrics
  // (per brand × day). NOTE (PR 3): bpm is DEPRECATED for reads — dashboards read
  // tiktok_shop_performance directly now; this roll-up keeps bpm's audit/history
  // trail current and asserts the fold is exact. Isolated like every other step: a reconcile
  // failure is recorded in the summary, never thrown.
  try {
    summary.reconcile = await reconcileTikTok({
      orgId: orgScope,
      window: { startDate: win.startDate, endDate: win.endDate },
    });
    if (summary.reconcile.status !== "success") {
      summary.errors.push(`reconcile: ${summary.reconcile.warnings.join("; ") || "mismatch"}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    summary.errors.push(`reconcile: ${message}`);
    console.error("[tiktok] reconcile failed", message);
  }

  // SECOND ROLL-UP — fold the same landed data up into the metric_entries API
  // overlay, but PER BRAND (grouped by tiktok_shops.brand_id) so the COO/Ecom
  // reconciliation gate validates each brand's ecom.* figures instead of one
  // org-wide row. Isolated like every other step: a failure is recorded, never
  // thrown, and never blocks the reconcile result above.
  try {
    summary.metricEntries = await syncBrandMetricEntries({
      orgId: orgScope,
      window: { startDate: win.startDate, endDate: win.endDate },
    });
    if (summary.metricEntries.status !== "success") {
      summary.errors.push(
        `metric_entries: ${summary.metricEntries.warnings.join("; ") || "error"}`
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    summary.errors.push(`metric_entries: ${message}`);
    console.error("[tiktok] metric_entries per-brand failed", message);
  }

  // RUN CLASSIFICATION — for each org this pass touched, roll its per-shop tally
  // up into ONE classified run_summary row and write an audit trail entry with
  // the outcome. This is the signal the sync-health monitor reads: no more
  // "GitHub Actions says success" while a login-HTML bounce landed zero rows.
  const runs: Record<string, { status: string; upserted: number; steps: number; errors: number }> = {};
  for (const [orgId, acc] of orgRuns) {
    if (acc.steps === 0) continue; // nothing attempted — not a failure
    const status = classifyRun(acc);
    runs[orgId] = { status, upserted: acc.upserted, steps: acc.steps, errors: acc.errors.length };

    await writeSyncRunSummary({
      org_id: orgId,
      window: win,
      status,
      rows: acc.upserted,
      // Keep a short, PII-free reason on the row for a failed/partial run.
      error: acc.errors.length ? acc.errors.slice(0, 5).join(" | ") : undefined,
      startedAt: acc.startedAt,
    });

    // ONE audit_log row per org run, through #190's shared writeAudit
    // (public.audit_log, service-role). The action_audit action-request trail is
    // deliberately left untouched.
    await writeAudit({
      orgId,
      action: "sync",
      entityType: "tiktok_sync",
      entityId: orgId,
      actorUserId: actor?.id ?? null,
      actorRole: actor?.role ?? "system",
      detail: {
        source: isMachine ? "machine" : "manual",
        kind: isBackfill ? "backfill" : "daily",
        classification: status,
        window: { start: win.startDate, end: win.endDate },
        window_days: windowDays,
        steps: acc.steps,
        shops_ok: acc.successSteps,
        upserted: acc.upserted,
        auth_failure: acc.authFailure,
        // Decoupled proactive token refresh outcomes for THIS org (token-free) —
        // shows a stuck shop being un-stuck even when its data pull auth-failed.
        token_refresh:
          summary.tokenRefresh?.outcomes
            .filter((o) => o.org_id === orgId)
            .map((o) => ({ open_id: o.open_id, result: o.result, hoursToExpiry: o.hoursToExpiry })) ??
          [],
        error_count: acc.errors.length,
        errors: acc.errors.slice(0, 10),
      },
    });

    if (status === "failed" || status === "auth_failed") {
      console.error("[tiktok] sync run FAILED", { org: orgId, status, errors: acc.errors.slice(0, 5) });
    }
  }

  console.info("[tiktok] sync done", { ...summary, runs });
  return NextResponse.json({ ...summary, runs });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Vercel Cron issues a GET; support both so the same route serves cron + manual.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
