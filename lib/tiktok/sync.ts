import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  TIKTOK_API_BASE,
  TIKTOK_ORDERS_SEARCH_PATH,
  TIKTOK_FINANCE_STATEMENTS_PATH,
  TIKTOK_ANALYTICS_SHOP_PATH,
  TIKTOK_ANALYTICS_PRODUCTS_PATH,
  MARKETPLACE_TIKTOK,
  tiktokAppKey,
  tiktokAppSecret,
} from "@/lib/tiktok/config";
import { signRequest } from "@/lib/tiktok/sign";
import { getValidAccessToken } from "@/lib/tiktok/vault";

// The daily TikTok Shop READ-sync engine.
//
// Pulls in-window commerce data per authorized shop and lands it as DAILY
// AGGREGATES into the (already-provisioned) landing tables. It is:
//   • READ ONLY against TikTok — no writes back to the shop.
//   • PII-FREE — we store daily/aggregate/statement/product numbers only, NEVER
//     a buyer name, address, phone or any order-line customer detail.
//   • IDEMPOTENT — every landing write is an upsert keyed on a natural key, so
//     re-running a day overwrites rather than duplicates.
//   • FAIL-SOFT — each (shop, endpoint) step is isolated; a failure records a
//     tiktok_sync_runs row and never aborts the other shops/endpoints.
//
// Every business call is HMAC-SHA256 SIGNED (lib/tiktok/sign.ts) and carries the
// shop_cipher. Access tokens are fetched per shop via the locked vault and never
// leave the server.
//
// ⚠️ Endpoint paths, query params and response field names are the current
// known-good 202309+ shapes; CONFIRM each against Partner Center → your App →
// API Documents before relying on production numbers. The parsers below are
// deliberately defensive (try several field names) so a minor schema drift
// degrades a metric to null rather than throwing.

// Asia/Manila is a fixed UTC+8 (no DST), so a constant offset is exact.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Cap pagination so a misbehaving cursor can never loop forever. Sized so even a
// 90-day backfill of a busy shop isn't silently truncated: at 100 orders/page,
// 500 pages = 50k orders per window. If the cap IS hit while a cursor remains, we
// LOG it (never truncate silently — see the warnings in each paginated loop).
const MAX_PAGES = 500;
const ORDERS_PAGE_SIZE = 100;
const FINANCE_PAGE_SIZE = 50;
const PRODUCTS_PAGE_SIZE = 100;

// --- Types ------------------------------------------------------------------

// A shop to sync, joined to its connection so we can mint a valid token.
export interface SyncShop {
  org_id: string;
  shop_id: string;
  shop_cipher: string | null;
  brand_id: string | null;
  region: string | null;
  open_id: string;
  shop_name: string | null;
  // The connection's granted OAuth scopes (null when unknown). Lets the analytics
  // endpoints skip a doomed call when the Data/Analytics scope is absent.
  granted_scopes: string[] | null;
}

// The [today-N .. yesterday] window, in Asia/Manila, resolved to both the date
// strings we store and the unix-second bounds we pass to TikTok time filters.
export interface SyncWindow {
  // Inclusive first day (today - N) and inclusive last day (yesterday), YYYY-MM-DD.
  startDate: string;
  endDate: string;
  // The EXCLUSIVE upper-bound day for the analytics date filters, YYYY-MM-DD.
  // This is "today" in Manila — the day AFTER endDate. TikTok's 202405 analytics
  // filters (shop: end_date_lt, products: start_date_lt) are LESS-THAN / exclusive,
  // so to INCLUDE yesterday (endDate) we must pass the next day as the bound.
  endExclusiveDate: string;
  // create_time_ge (start of startDate, Manila) and create_time_lt (start of
  // today, Manila) as unix seconds — a half-open [ge, lt) range.
  startSec: number;
  endSec: number;
}

export type EndpointName =
  | "orders"
  | "settlements"
  | "shop_performance"
  | "product_performance";

// Outcome of one endpoint step (never thrown — the route logs it as a run row).
export interface EndpointResult {
  status: string; // 'success' | 'error' | 'skipped: analytics scope pending'
  rows: number;
  error?: string;
}

export interface LatestSyncRun {
  endpoint: string;
  shop_id: string | null;
  status: string;
  rows_upserted: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

// --- Window -----------------------------------------------------------------

// Format a UTC instant as its Asia/Manila calendar date (YYYY-MM-DD). Shifting
// by the fixed offset and reading the ISO date of the shifted instant yields the
// Manila local date without pulling in Intl.
function manilaDate(utcMs: number): string {
  return new Date(utcMs + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

// Resolve the sync window for N days ending yesterday, in Asia/Manila.
export function resolveWindow(days: number): SyncWindow {
  const n = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 1;
  // Start of "today" in Manila, expressed as a real UTC epoch ms. Floor the
  // Manila-shifted clock to a day boundary, then shift back to true UTC.
  const todayStartUtcMs = Math.floor((Date.now() + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
  const startUtcMs = todayStartUtcMs - n * DAY_MS; // start of (today - N)
  return {
    startDate: manilaDate(startUtcMs),
    endDate: manilaDate(todayStartUtcMs - DAY_MS), // yesterday
    endExclusiveDate: manilaDate(todayStartUtcMs), // today — exclusive bound for analytics _lt filters
    startSec: Math.floor(startUtcMs / 1000),
    endSec: Math.floor(todayStartUtcMs / 1000), // exclusive upper bound (start of today)
  };
}

// --- Signed business call ---------------------------------------------------

interface ApiResponse {
  ok: boolean;
  httpStatus: number;
  code: number | undefined;
  message: string | undefined;
  data: Record<string, unknown> | null;
}

// Make one SIGNED business API call. `query` is every query param EXCEPT app_key,
// timestamp and sign (those are added + signed here). `body` (POST only) is
// appended to the signed string exactly as sent.
//
// Exported so sibling readers (e.g. the Product-API writer in lib/tiktok/products.ts)
// reuse this EXACT signer + login-bounce/401 classification instead of copying it —
// the silent HTML-login-success path this closes must never be re-introduced.
export async function callApi(opts: {
  method: "GET" | "POST";
  path: string;
  accessToken: string;
  query?: Record<string, string | number>;
  body?: unknown;
}): Promise<ApiResponse> {
  const appKey = tiktokAppKey();
  const appSecret = tiktokAppSecret();
  if (!appKey || !appSecret) throw new Error("TikTok app credentials not configured");

  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = { app_key: appKey, timestamp: String(timestamp) };
  for (const [k, v] of Object.entries(opts.query ?? {})) params[k] = String(v);

  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const sign = signRequest(appSecret, opts.path, params, bodyStr);

  const url = new URL(`${TIKTOK_API_BASE}${opts.path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("sign", sign);

  const res = await fetch(url, {
    method: opts.method,
    headers: { "x-tts-access-token": opts.accessToken, "content-type": "application/json" },
    body: bodyStr,
  });

  // Read the body as TEXT first so we can tell a real JSON API reply apart from
  // an auth/login bounce. When a token is invalid or expired, TikTok (or an
  // edge in front of it) can answer with a 200 + an HTML login page instead of
  // JSON. The old `res.json().catch(() => null)` swallowed that into a null body
  // whose `code` was undefined — so the "non-zero code" throw NEVER fired and the
  // step returned "success" with 0 rows. That single silent path is exactly how
  // the sync bounced to /login for two days while GitHub Actions reported success. We now
  // detect it explicitly and FAIL LOUD (see classifyAuthFailure / TikTokAuthError).
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const rawText = await res.text().catch(() => "");
  const looksLikeHtml =
    contentType.includes("text/html") || /^\s*<(?:!doctype|html|head|body)\b/i.test(rawText);

  // An HTML body where JSON was expected is a login bounce — TikTok (or an edge in
  // front of it) answers an invalid/expired token with an HTML /login page instead
  // of JSON. That is ALWAYS a genuine token failure, never a data reply, so throw:
  // the step is recorded as an error, the run classifies auth_failed, and the
  // proactive refresh (which already ran up front) un-sticks the shop. This is the
  // silent-success path #? closed — see the note above.
  if (looksLikeHtml) {
    throw new TikTokAuthError(
      `TikTok returned an auth/login response (HTTP ${res.status}, HTML body) — the access token is likely invalid or expired`
    );
  }

  let json: { code?: number; message?: string; data?: Record<string, unknown> } | null = null;
  if (rawText.trim()) {
    try {
      json = JSON.parse(rawText);
    } catch {
      json = null;
    }
  }
  const parsed: ApiResponse = {
    ok: res.ok,
    httpStatus: res.status,
    code: json?.code,
    message: json?.message,
    data: json?.data ?? null,
  };

  // A 401 needs CLASSIFYING, not blanket-blaming the token. TikTok answers 401 for
  // BOTH a genuinely invalid/expired token AND (on the analytics endpoints) a token
  // that is valid but simply lacks the Data/Analytics scope. Only the former is an
  // auth failure. If the response's code+message signals a permission/scope denial
  // we DON'T throw — we return it so the caller (the analytics endpoints) records a
  // truthful 'skipped: analytics scope pending' instead of a misleading "token
  // expired" (the existing status the system already speaks). Anything
  // else at 401 is a real token failure: throw TikTokAuthError so the run classifies
  // auth_failed and the proactive refresh kicks in (guardrail: never weaken auth).
  if (res.status === 401 && !isScopeDenied(parsed)) {
    throw new TikTokAuthError(
      `TikTok returned an auth/login response (HTTP ${res.status}) — the access token is likely invalid or expired`
    );
  }
  return parsed;
}

// Thrown by callApi when TikTok answers with an auth/login response (a 401, or
// an HTML login page where JSON was expected) instead of a data reply. The sync
// route detects this (instanceof) to classify the whole run as auth-failed —
// the signal the health monitor turns into a sync_health_alert.
export class TikTokAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TikTokAuthError";
  }
}

// True when an error propagated out of a step is (or wraps) an auth/login
// response. Used by the sync route to distinguish an auth bounce from an
// ordinary endpoint error when classifying the run.
export function isAuthFailure(err: unknown): boolean {
  if (err instanceof TikTokAuthError) return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /auth\/login response|access token is likely invalid|no valid access token/i.test(msg);
}

// A genuine invalid/expired TOKEN — TikTok words these around the token itself
// ("access token is invalid", "token expired", "invalid access_token"). These are
// auth failures, never scope denials, and must NEVER be reclassified as scope.
const TOKEN_FAILURE_RE = /token[^.]*\b(invalid|expir)|(invalid|expir)[^.]*token/i;

// A PERMISSION / SCOPE / AUTHORIZATION denial — TikTok words these around access
// rights ("no permission", "not authorized", "unauthorized scope", "access
// denied", "does not have the scope"). The corresponding TikTok error codes vary
// by app/version, so message-matching is the primary signal; the code set below
// is a backstop for terse replies.
const SCOPE_DENIED_RE = /permission|scope|not\s+authoriz|unauthoriz|access\s+deni|forbidden|not\s+grant|no\s+access/i;
// Known TikTok Shop codes that mean "this token lacks the endpoint's scope"
// (vs. a bad token). Extend as new codes surface; matching here is a backstop —
// an unlisted code still falls through to the message check.
const SCOPE_DENIED_CODES = new Set<number>([105004, 105005]);

// TikTok signals "you don't have this scope" as an HTTP 403, a known scope-denied
// body code, or a body/HTTP message that mentions permission/scope/authorization
// denial. Analytics (shop_performance / product_performance) is the only endpoint
// we expect this from — the Data/Analytics scope is not granted — so we turn it
// into a truthful 'skipped: analytics scope pending' outcome rather than a hard error or, worse,
// a bogus "token expired". A message that clearly names the TOKEN as invalid/
// expired is a real auth failure and wins over any permission wording.
function isScopeDenied(r: ApiResponse): boolean {
  const msg = r.message ?? "";
  if (TOKEN_FAILURE_RE.test(msg)) return false;
  if (r.httpStatus === 403) return true;
  if (r.code !== undefined && r.code !== 0 && SCOPE_DENIED_CODES.has(r.code)) return true;
  if (SCOPE_DENIED_RE.test(msg)) return true;
  return false;
}

// A non-zero body code (or non-2xx) that ISN'T a scope denial is a real failure.
// Exported alongside callApi so reusing callers format API errors identically.
export function apiErrorMessage(r: ApiResponse): string {
  return `TikTok API ${r.httpStatus} code=${r.code ?? "?"} ${r.message ?? ""}`.trim();
}

// --- Small parse helpers ----------------------------------------------------

// Coerce a string|number|null to a finite number, or null. TikTok returns money
// amounts as strings.
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// First present numeric value across candidate keys of an object.
function pickNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (k in obj) {
      const n = num(obj[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

// --- Landing-table upserts (service role; RLS-locked tables) ----------------

type UpsertDb = {
  from: (t: string) => {
    upsert: (
      v: Record<string, unknown>[],
      opts: { onConflict: string }
    ) => Promise<{ error: unknown }>;
  };
};

async function upsertRows(
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string
): Promise<number> {
  if (!rows.length) return 0;
  const svc = createServiceRoleClient() as unknown as UpsertDb;
  const { error } = await svc.from(table).upsert(rows, { onConflict });
  if (error) throw new Error(`upsert ${table} failed: ${JSON.stringify(error)}`);
  return rows.length;
}

// --- Marketplace bridge -----------------------------------------------------

// marketplace_orders_daily (the table the OS Data Analytics reads) is keyed by a
// marketplace_shops.id UUID, NOT the TikTok text shop_id. Each TikTok shop maps
// 1:1 to a marketplace_shops row on (org_id, marketplace='tiktok_shop',
// external_shop_id=<tiktok shop_id>). Ensure that bridge row exists (idempotent
// upsert on the unique key) and return its UUID so the daily-orders write can
// satisfy the foreign key. Returns null only if the upsert itself errors.
type UpsertReturningDb = {
  from: (t: string) => {
    upsert: (
      v: Record<string, unknown>[],
      opts: { onConflict: string }
    ) => {
      select: (c: string) => Promise<{ data: { id: string }[] | null; error: unknown }>;
    };
  };
};

export async function ensureMarketplaceShopId(shop: SyncShop): Promise<string | null> {
  const svc = createServiceRoleClient() as unknown as UpsertReturningDb;
  const { data, error } = await svc
    .from("marketplace_shops")
    .upsert(
      [
        {
          org_id: shop.org_id,
          marketplace: MARKETPLACE_TIKTOK,
          external_shop_id: shop.shop_id,
          shop_name: shop.shop_name,
          brand_id: shop.brand_id,
          region: shop.region,
          status: "active",
        },
      ],
      { onConflict: "org_id,marketplace,external_shop_id" }
    )
    .select("id");
  if (error) {
    console.error("[tiktok] ensureMarketplaceShopId failed", shop.shop_id, error);
    return null;
  }
  return data?.[0]?.id ?? null;
}

// --- Endpoint 1: ORDERS → daily shop performance aggregate ------------------

// Search all in-window orders (paginated) and fold them into per-day totals:
// GMV (order value), order count and unit count. We read line-item COUNT and
// order totals only — no buyer identity is touched or stored.
// An order whose status marks it cancelled/returned/refunded counts toward the
// day's `returns`. TikTok's order statuses vary by version, so match defensively.
const RETURN_STATUS_RE = /cancel|return|refund/i;

interface OrderDaily {
  gmv: number;
  orders: number;
  units: number;
  returns: number; // orders in a cancelled/returned/refunded status
  currency: string | null;
}

export async function syncOrders(shop: SyncShop, token: string, win: SyncWindow): Promise<EndpointResult> {
  // date → running totals
  const daily = new Map<string, OrderDaily>();
  // One landing row per real TikTok order, keyed by order_id so a duplicate the
  // pager hands back within the same run (or a re-run) collapses to one entry.
  // This is what TikTok App Review checks: a genuine store order_id. PII-free —
  // id / status / money total / currency / create time only.
  const orderRows = new Map<string, Record<string, unknown>>();
  const nowIso = new Date().toISOString();

  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string | number> = {
      shop_cipher: shop.shop_cipher ?? "",
      page_size: ORDERS_PAGE_SIZE,
    };
    if (pageToken) query.page_token = pageToken;

    const r = await callApi({
      method: "POST",
      path: TIKTOK_ORDERS_SEARCH_PATH,
      accessToken: token,
      query,
      // Half-open [ge, lt) create-time window in unix seconds.
      body: { create_time_ge: win.startSec, create_time_lt: win.endSec },
    });
    if (!r.ok || (r.code && r.code !== 0)) throw new Error(apiErrorMessage(r));

    const data = r.data ?? {};
    const orders = Array.isArray(data.orders) ? (data.orders as Record<string, unknown>[]) : [];
    for (const o of orders) {
      const createTime = num(o.create_time);
      if (createTime === null) continue;
      const date = manilaDate(createTime * 1000);
      const bucket = daily.get(date) ?? { gmv: 0, orders: 0, units: 0, returns: 0, currency: null };

      // GMV: prefer the order payment total; fall back to summing line prices.
      const payment = (o.payment as Record<string, unknown> | undefined) ?? {};
      let gmv = pickNum(payment, ["total_amount", "sub_total"]);
      const lineItems = Array.isArray(o.line_items)
        ? (o.line_items as Record<string, unknown>[])
        : [];
      if (gmv === null) {
        gmv = lineItems.reduce((sum, li) => sum + (pickNum(li, ["sale_price", "original_price"]) ?? 0), 0);
      }
      bucket.gmv += gmv ?? 0;
      bucket.orders += 1;
      // In 202309 each line_item is one unit; sum an explicit quantity if present.
      bucket.units += lineItems.reduce((sum, li) => sum + (pickNum(li, ["quantity"]) ?? 1), 0);
      const status = pickStr(o, ["status", "order_status"]);
      if (status && RETURN_STATUS_RE.test(status)) bucket.returns += 1;
      // First currency we see for the day wins (all a shop's orders share one).
      const orderCurrency = pickStr(payment, ["currency"]) ?? pickStr(o, ["currency"]);
      if (!bucket.currency) bucket.currency = orderCurrency;
      daily.set(date, bucket);

      // Land the individual order too (the App-Review requirement). The order's
      // own id under several known field names; skip if TikTok gave us none —
      // a row with no order_id is worthless and would violate the NOT NULL key.
      const orderId = pickStr(o, ["id", "order_id"]);
      if (orderId) {
        orderRows.set(orderId, {
          org_id: shop.org_id,
          shop_id: shop.shop_id,
          brand_id: shop.brand_id,
          order_id: orderId,
          status,
          amount: gmv,
          currency: orderCurrency,
          order_created_at: new Date(createTime * 1000).toISOString(),
          synced_at: nowIso,
        });
      }
    }

    pageToken = typeof data.next_page_token === "string" ? data.next_page_token : "";
    if (!pageToken) break;
    if (page === MAX_PAGES - 1 && pageToken) {
      // Cap reached with a cursor still open — surface it so a truncated backfill
      // isn't mistaken for a complete one (guardrail: no silent caps).
      console.warn("[tiktok] syncOrders hit MAX_PAGES with cursor remaining", {
        shop: shop.shop_id,
        window: [win.startDate, win.endDate],
        maxPages: MAX_PAGES,
      });
    }
  }

  const now = new Date().toISOString();

  // 1) tiktok_shop_performance — unchanged source of truth for the reconcile step.
  const perfRows = Array.from(daily.entries()).map(([stat_date, t]) => ({
    org_id: shop.org_id,
    shop_id: shop.shop_id,
    brand_id: shop.brand_id,
    stat_date,
    gmv: t.gmv,
    orders: t.orders,
    units: t.units,
    source: "tiktok_api",
    synced_at: now,
  }));
  await upsertRows("tiktok_shop_performance", perfRows, "org_id,shop_id,stat_date");

  // 2) marketplace_orders_daily — the table the OS Data Analytics reads. Write
  //    gmv / orders / units / returns / currency per shop-day here; `refunds` is
  //    owned by the settlements step (real finance figure), so it is deliberately
  //    NOT in this payload — a re-run must never clobber a landed refund with 0.
  //    Keyed by the marketplace_shops UUID via the ensured bridge row.
  const marketplaceShopId = await ensureMarketplaceShopId(shop);
  if (!marketplaceShopId) {
    throw new Error(`could not resolve marketplace_shops bridge for shop ${shop.shop_id}`);
  }
  const mpRows = Array.from(daily.entries()).map(([order_date, t]) => ({
    org_id: shop.org_id,
    shop_id: marketplaceShopId,
    order_date,
    gmv: t.gmv,
    orders: t.orders,
    units: t.units,
    returns: t.returns,
    currency: t.currency ?? "PHP",
    raw: { source: "tiktok_api", tiktok_shop_id: shop.shop_id },
    synced_at: now,
  }));
  const rowsUpserted = await upsertRows("marketplace_orders_daily", mpRows, "shop_id,order_date");

  // 3) tiktok_orders — one row per REAL order, the App-Review evidence. Idempotent
  //    upsert on (org_id, order_id) so a re-run or overlapping backfill refreshes
  //    in place. Written LAST so the aggregate landing (the tables dashboards read)
  //    is never held hostage to this write; a failure here still throws and marks
  //    the orders step errored (per-shop isolation), same as the aggregate path.
  const orderRowCount = await upsertRows(
    "tiktok_orders",
    Array.from(orderRows.values()),
    "org_id,order_id"
  );
  console.info("[tiktok] syncOrders landed individual orders", {
    shop: shop.shop_id,
    orders: orderRowCount,
    days: mpRows.length,
  });
  return { status: "success", rows: rowsUpserted };
}

// --- Endpoint 2: SETTLEMENTS ------------------------------------------------

// Pull in-window finance statements and land gross / fee / refund / net per
// statement. Statement-level money only — no customer data exists here.
export async function syncSettlements(shop: SyncShop, token: string, win: SyncWindow): Promise<EndpointResult> {
  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string | number> = {
      shop_cipher: shop.shop_cipher ?? "",
      page_size: FINANCE_PAGE_SIZE,
      sort_field: "statement_time",
      statement_time_ge: win.startSec,
      statement_time_lt: win.endSec,
    };
    if (pageToken) query.page_token = pageToken;

    const r = await callApi({
      method: "GET",
      path: TIKTOK_FINANCE_STATEMENTS_PATH,
      accessToken: token,
      query,
    });
    if (!r.ok || (r.code && r.code !== 0)) throw new Error(apiErrorMessage(r));

    const data = r.data ?? {};
    const statements = Array.isArray(data.statements)
      ? (data.statements as Record<string, unknown>[])
      : [];
    for (const s of statements) {
      const statementId = pickStr(s, ["id", "statement_id"]);
      if (!statementId) continue;
      const statementTime = pickNum(s, ["statement_time"]);
      rows.push({
        org_id: shop.org_id,
        shop_id: shop.shop_id,
        brand_id: shop.brand_id,
        statement_id: statementId,
        stat_date: statementTime !== null ? manilaDate(statementTime * 1000) : null,
        gross_amount: pickNum(s, ["revenue_amount", "gross_amount", "total_revenue"]),
        fee_amount: pickNum(s, ["fee_amount", "fee_total", "total_fees"]),
        refund_amount: pickNum(s, ["adjustment_amount", "refund_amount", "total_refund"]),
        net_amount: pickNum(s, ["settlement_amount", "net_amount", "net_sales_amount"]),
        currency: pickStr(s, ["currency"]) ?? "PHP",
        source: "tiktok_api",
        synced_at: now,
      });
    }

    pageToken = typeof data.next_page_token === "string" ? data.next_page_token : "";
    if (!pageToken) break;
    if (page === MAX_PAGES - 1 && pageToken) {
      console.warn("[tiktok] syncSettlements hit MAX_PAGES with cursor remaining", {
        shop: shop.shop_id,
        window: [win.startDate, win.endDate],
        maxPages: MAX_PAGES,
      });
    }
  }

  const rowsUpserted = await upsertRows("tiktok_settlements", rows, "org_id,shop_id,statement_id");

  // Enrich marketplace_orders_daily.refunds — the authoritative finance figure
  // lives in settlements, not orders. Sum |refund_amount| per statement day and
  // upsert ONLY the refunds column onto the same (shop_id, order_date) rows the
  // orders step created (missing columns are left untouched on conflict, so gmv/
  // orders/units survive). Best-effort: if the bridge can't be resolved we log
  // and skip rather than failing the settlements landing.
  const marketplaceShopId = await ensureMarketplaceShopId(shop);
  if (marketplaceShopId) {
    const refundByDay = new Map<string, number>();
    for (const row of rows) {
      const day = row.stat_date as string | null;
      const refund = row.refund_amount as number | null;
      if (day && refund !== null) {
        refundByDay.set(day, (refundByDay.get(day) ?? 0) + Math.abs(refund));
      }
    }
    if (refundByDay.size) {
      const refundRows = Array.from(refundByDay.entries()).map(([order_date, refunds]) => ({
        org_id: shop.org_id,
        shop_id: marketplaceShopId,
        order_date,
        refunds,
        synced_at: now,
      }));
      await upsertRows("marketplace_orders_daily", refundRows, "shop_id,order_date");
    }
  } else {
    console.error("[tiktok] settlements: no marketplace bridge for shop", shop.shop_id);
  }

  return { status: "success", rows: rowsUpserted };
}

// --- Endpoint 3a: SHOP PERFORMANCE (Analytics — may 403) --------------------

// The status for an analytics endpoint whose Data/Analytics scope is NOT granted.
// This is NOT a token problem: GMV/orders (order + finance scopes) sync fine on
// the very same token. We REUSE the exact string the pre-existing scope-skip
// handling already wrote (53 rows, Jul 12–19) so this one real state stays under
// ONE label instead of fragmenting across 'error' / a new invented string — the
// recent regression to 'error / token expired' is what sent the team to Reconnect
// forever. The descriptive message below is stored alongside on the run row.
export const ANALYTICS_SKIPPED_STATUS = "skipped: analytics scope pending";
export const ANALYTICS_SCOPE_DENIED_MESSAGE =
  "TikTok analytics scope not granted for this shop — GMV/orders unaffected; grant the Data/Analytics scope to enable traffic & conversion metrics.";

// A soft-skip result: the analytics scope is absent — either detected live (a
// scope-denied 401/403) or from the connection's granted_scopes BEFORE any call.
// Same honest status the system already speaks, now with the explanatory message.
const scopeDeniedResult = (): EndpointResult => ({
  status: ANALYTICS_SKIPPED_STATUS,
  rows: 0,
  error: ANALYTICS_SCOPE_DENIED_MESSAGE,
});

// Scope strings that grant TikTok's Data/Analytics endpoints. The exact registered
// scope name varies by app, so we match any scope whose name signals analytics /
// data / performance / traffic access — broadly, so a shop that DOES have it is
// NEVER wrongly skipped (a false skip would drop real analytics data). We only act
// on the NEGATIVE: a non-empty scope list with nothing analytics-shaped in it.
const ANALYTICS_SCOPE_RE = /analyt|performance|traffic|conversion|\bdata\b|data[._-]/i;

// Tri-state: can we skip the analytics call for this connection?
//   • false — scopes ARE on record and none of them grant analytics → skip is SAFE.
//   • true  — an analytics-shaped scope is present → DO call (may still 401).
//   • null  — no scope list on record (unknown) → DO call; rely on the 401 branch.
// Only a `false` here short-circuits; anything else makes the real call so the
// error-code classifier in isScopeDenied stays the source of truth.
function hasAnalyticsScope(scopes: string[] | null | undefined): boolean | null {
  if (!scopes || scopes.length === 0) return null;
  return scopes.some((s) => typeof s === "string" && ANALYTICS_SCOPE_RE.test(s));
}

// Enrich the daily shop-performance rows with visitors / page_views /
// conversion_rate. On a scope denial this is a soft skip (status recorded, run
// not failed). We upsert on the same (org,shop,date) key, so the gmv/orders/
// units written by the orders step survive (only the columns we set are updated).
export async function syncShopPerformance(shop: SyncShop, token: string, win: SyncWindow): Promise<EndpointResult> {
  // Efficiency: if the connection's granted_scopes are on record and none grant
  // analytics, skip the network call entirely and record the honest status. The
  // live 401 branch below stays the fallback whenever scopes are unknown.
  if (hasAnalyticsScope(shop.granted_scopes) === false) return scopeDeniedResult();

  const r = await callApi({
    method: "GET",
    path: TIKTOK_ANALYTICS_SHOP_PATH,
    accessToken: token,
    // 202405 "Get Shop Performance" REQUIRES a date range (missing it errors with
    // code=36009004 "StartDateGe is a required field"). The confirmed param names
    // are start_date_ge (inclusive, YYYY-MM-DD) + end_date_lt (EXCLUSIVE), so we
    // pass endExclusiveDate (today) to include yesterday. granularity=1D → per-day.
    query: {
      shop_cipher: shop.shop_cipher ?? "",
      start_date_ge: win.startDate,
      end_date_lt: win.endExclusiveDate,
      granularity: "1D",
    },
  });
  if (isScopeDenied(r)) return scopeDeniedResult();
  if (!r.ok || (r.code && r.code !== 0)) throw new Error(apiErrorMessage(r));

  const data = r.data ?? {};
  const performance = (data.performance as Record<string, unknown> | undefined) ?? data;
  const intervals = Array.isArray(performance.intervals)
    ? (performance.intervals as Record<string, unknown>[])
    : Array.isArray(data.intervals)
      ? (data.intervals as Record<string, unknown>[])
      : [];

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  for (const iv of intervals) {
    const statDate = pickStr(iv, ["start_date", "date", "stat_date"]) ?? win.endDate;
    const visitors = pickNum(iv, ["visitors", "uv", "unique_visitors"]);
    const pageViews = pickNum(iv, ["page_views", "pv", "views"]);
    let conversion = pickNum(iv, ["conversion_rate", "click_to_order_rate"]);
    // Derive a conversion rate if only raw counts came back.
    if (conversion === null) {
      const orders = pickNum(iv, ["orders", "sku_orders"]);
      if (orders !== null && visitors && visitors > 0) conversion = orders / visitors;
    }
    rows.push({
      org_id: shop.org_id,
      shop_id: shop.shop_id,
      brand_id: shop.brand_id,
      stat_date: statDate,
      visitors,
      page_views: pageViews,
      conversion_rate: conversion,
      source: "tiktok_api",
      synced_at: now,
    });
  }

  const rowsUpserted = await upsertRows("tiktok_shop_performance", rows, "org_id,shop_id,stat_date");
  return { status: "success", rows: rowsUpserted };
}

// --- Endpoint 3b: PRODUCT PERFORMANCE (Analytics — may 403) -----------------

// Per-product daily performance. Stat_date is the window's last day (the sync's
// representative day; the daily cron runs with days=1 → exactly yesterday).
export async function syncProductPerformance(shop: SyncShop, token: string, win: SyncWindow): Promise<EndpointResult> {
  // Same pre-flight skip as shop performance: no analytics scope on record → don't
  // even make the call, just record 'skipped: analytics scope pending'.
  if (hasAnalyticsScope(shop.granted_scopes) === false) return scopeDeniedResult();

  const rows: Record<string, unknown>[] = [];
  const now = new Date().toISOString();

  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    // 202405 "Get Shop Product Performance List" REQUIRES a date range. Live
    // calls that sent start_date_lt failed with code=36009004 "EndDateLt is a
    // required field" — this endpoint uses the SAME bounds as shop/performance:
    // start_date_ge (inclusive) + end_date_lt (EXCLUSIVE, YYYY-MM-DD), NOT
    // start_date_lt. endExclusiveDate (today) keeps yesterday inside the window.
    const query: Record<string, string | number> = {
      shop_cipher: shop.shop_cipher ?? "",
      start_date_ge: win.startDate,
      end_date_lt: win.endExclusiveDate,
      page_size: PRODUCTS_PAGE_SIZE,
    };
    if (pageToken) query.page_token = pageToken;

    const r = await callApi({
      method: "GET",
      path: TIKTOK_ANALYTICS_PRODUCTS_PATH,
      accessToken: token,
      query,
    });
    if (isScopeDenied(r)) return scopeDeniedResult();
    if (!r.ok || (r.code && r.code !== 0)) throw new Error(apiErrorMessage(r));

    const data = r.data ?? {};
    const products = Array.isArray(data.products)
      ? (data.products as Record<string, unknown>[])
      : [];
    for (const p of products) {
      const productId = pickStr(p, ["id", "product_id"]);
      if (!productId) continue;
      const perf = (p.performance as Record<string, unknown> | undefined) ?? p;
      rows.push({
        org_id: shop.org_id,
        shop_id: shop.shop_id,
        brand_id: shop.brand_id,
        stat_date: win.endDate,
        product_id: productId,
        sku: pickStr(p, ["sku", "seller_sku", "sku_id"]),
        product_name: pickStr(p, ["name", "product_name", "title"]),
        gmv: pickNum(perf, ["gmv", "sales_amount", "revenue"]),
        units: pickNum(perf, ["units_sold", "units", "sku_orders"]),
        orders: pickNum(perf, ["orders", "order_count"]),
        page_views: pickNum(perf, ["page_views", "pv", "views"]),
        source: "tiktok_api",
        synced_at: now,
      });
    }

    pageToken = typeof data.next_page_token === "string" ? data.next_page_token : "";
    if (!pageToken) break;
    if (page === MAX_PAGES - 1 && pageToken) {
      console.warn("[tiktok] syncProductPerformance hit MAX_PAGES with cursor remaining", {
        shop: shop.shop_id,
        window: [win.startDate, win.endDate],
        maxPages: MAX_PAGES,
      });
    }
  }

  const rowsUpserted = await upsertRows(
    "tiktok_product_performance",
    rows,
    "org_id,shop_id,product_id,stat_date"
  );
  return { status: "success", rows: rowsUpserted };
}

// --- Shop loader ------------------------------------------------------------

type ShopJoinDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => {
        eq: (
          col: string,
          v: string
        ) => Promise<{ data: RawShopJoinRow[] | null; error: unknown }>;
      } & Promise<{ data: RawShopJoinRow[] | null; error: unknown }>;
    };
  };
};

interface RawShopJoinRow {
  org_id: string;
  shop_id: string;
  shop_cipher: string | null;
  brand_id: string | null;
  region: string | null;
  shop_name: string | null;
  tiktok_connections:
    | { open_id: string; granted_scopes: string[] | null }
    | { open_id: string; granted_scopes: string[] | null }[]
    | null;
}

// Load all active shops (optionally scoped to one org for a manual run), joined
// to their connection's open_id so the caller can mint a valid token per shop.
export async function listShopsForSync(orgId?: string): Promise<SyncShop[]> {
  const svc = createServiceRoleClient() as unknown as ShopJoinDb;
  const cols =
    "org_id, shop_id, shop_cipher, brand_id, region, shop_name, tiktok_connections(open_id, granted_scopes)";
  const base = svc.from("tiktok_shops").select(cols).eq("status", "active");
  const { data, error } = orgId ? await base.eq("org_id", orgId) : await base;
  if (error) {
    console.error("[tiktok] listShopsForSync failed", error);
    return [];
  }
  if (!data) return [];
  return data
    .map((r): SyncShop | null => {
      const conn = Array.isArray(r.tiktok_connections)
        ? r.tiktok_connections[0]
        : r.tiktok_connections;
      const openId = conn?.open_id;
      if (!openId) return null;
      return {
        org_id: r.org_id,
        shop_id: r.shop_id,
        shop_cipher: r.shop_cipher,
        brand_id: r.brand_id,
        region: r.region,
        shop_name: r.shop_name,
        open_id: openId,
        granted_scopes: conn?.granted_scopes ?? null,
      };
    })
    .filter((s): s is SyncShop => s !== null);
}

// Re-export so the route can refresh tokens without importing the vault too.
export { getValidAccessToken };

// --- Sync-run log -----------------------------------------------------------

type RunInsertDb = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<{ error: unknown }>;
  };
};

// Write exactly one tiktok_sync_runs row for a (shop, endpoint) step. Best-effort
// — a logging failure is itself logged but never propagated (the sync's own
// success/failure must not hinge on the audit write).
export async function writeSyncRun(row: {
  org_id: string;
  shop_id: string;
  endpoint: EndpointName;
  window: SyncWindow;
  status: string;
  rows: number;
  error?: string;
  startedAt: string;
}): Promise<void> {
  try {
    const svc = createServiceRoleClient() as unknown as RunInsertDb;
    const { error } = await svc.from("tiktok_sync_runs").insert({
      org_id: row.org_id,
      shop_id: row.shop_id,
      endpoint: row.endpoint,
      window_start: row.window.startDate,
      window_end: row.window.endDate,
      status: row.status,
      rows_upserted: row.rows,
      error_message: row.error ?? null,
      started_at: row.startedAt,
      finished_at: new Date().toISOString(),
    });
    if (error) console.error("[tiktok] writeSyncRun failed", error);
  } catch (e) {
    console.error("[tiktok] writeSyncRun threw", e);
  }
}

// --- Run-level classification (the "did this sync TRULY succeed?" signal) ----
//
// Per-endpoint rows answer "what happened to each step". They do NOT answer the
// question the health monitor asks: did the WHOLE run land any data, or did it
// silently fail? We roll each org's steps up into ONE run_summary row with a
// classified status so a scheduled check can read a single, honest verdict.

// The sentinel endpoint value for a run-level roll-up row (shop_id is null on
// these — they summarise the org's run, not one shop/endpoint step).
export const RUN_SUMMARY_ENDPOINT = "run_summary";

// The classified outcome of a whole sync pass for one org:
//   • success     — at least one step landed data and nothing errored
//   • partial     — some steps landed data, but at least one errored
//   • failed      — no step succeeded (0 successful shop upserts)
//   • auth_failed — an auth/login-HTML response or an unmintable token
// `failed` and `auth_failed` are both "the sync TRULY failed" for the monitor.
export type SyncRunStatus = "success" | "partial" | "failed" | "auth_failed";

// The per-org tally the sync route accumulates as it walks that org's shops.
export interface SyncRunAccumulator {
  startedAt: string;
  steps: number; // (shop × endpoint) steps attempted
  successSteps: number; // steps that returned a 'success' status
  upserted: number; // total landing rows upserted across the org
  authFailure: boolean; // any auth/login response or no-token-mintable shop
  errors: string[]; // human-readable per-step errors
}

// Classify one org's run from its accumulated tally. Auth trumps everything (a
// bounced token is the loudest failure); then "nothing succeeded" is a hard
// fail; a mix is partial; otherwise success.
export function classifyRun(acc: SyncRunAccumulator): SyncRunStatus {
  if (acc.authFailure) return "auth_failed";
  if (acc.successSteps === 0) return "failed";
  if (acc.errors.length > 0) return "partial";
  return "success";
}

// Write the single run_summary row for an org's pass. Best-effort, same idiom as
// writeSyncRun. shop_id is null and endpoint is the run_summary sentinel.
export async function writeSyncRunSummary(row: {
  org_id: string;
  window: SyncWindow;
  status: SyncRunStatus;
  rows: number;
  error?: string;
  startedAt: string;
}): Promise<void> {
  try {
    const svc = createServiceRoleClient() as unknown as RunInsertDb;
    const { error } = await svc.from("tiktok_sync_runs").insert({
      org_id: row.org_id,
      shop_id: null,
      endpoint: RUN_SUMMARY_ENDPOINT,
      window_start: row.window.startDate,
      window_end: row.window.endDate,
      status: row.status,
      rows_upserted: row.rows,
      error_message: row.error ?? null,
      started_at: row.startedAt,
      finished_at: new Date().toISOString(),
    });
    if (error) console.error("[tiktok] writeSyncRunSummary failed", error);
  } catch (e) {
    console.error("[tiktok] writeSyncRunSummary threw", e);
  }
}

// --- Last-synced status (UI) ------------------------------------------------

type LatestRunDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => {
        order: (
          col: string,
          opts: { ascending: boolean }
        ) => {
          limit: (n: number) => Promise<{ data: LatestSyncRun[] | null; error: unknown }>;
        };
      };
    };
  };
};

// The newest sync-run row for an org, for the "Last synced" status line.
export async function getLatestSyncRun(orgId: string): Promise<LatestSyncRun | null> {
  try {
    const svc = createServiceRoleClient() as unknown as LatestRunDb;
    const { data, error } = await svc
      .from("tiktok_sync_runs")
      .select("endpoint, shop_id, status, rows_upserted, error_message, started_at, finished_at")
      .eq("org_id", orgId)
      .order("started_at", { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  } catch (e) {
    console.error("[tiktok] getLatestSyncRun threw", e);
    return null;
  }
}

// --- Connection sync status (Settings) --------------------------------------
//
// The Settings page must tell the honest truth: a run where GMV/orders landed but
// the analytics endpoints skipped for a missing scope is NOT a broken connection —
// it is a SYNCED connection missing an optional (analytics) scope. Reading the
// newest per-step row (product_performance, the last step) made the whole
// connection go red on exactly that case, sending the team to Reconnect forever.
// Instead we read:
//   • the newest run_summary — the CLASSIFIED commerce verdict (orders/settlements),
//     which never fails on an analytics scope denial (that's not counted an error);
//   • whether the newest analytics steps reported the scope-skipped status —
//     surfaced as a soft note, not a failure.
export interface ConnectionSyncStatus {
  lastSyncedAt: string | null; // newest finished_at (or started_at) we saw
  // Classified commerce verdict from the newest run_summary row:
  // 'success' | 'partial' | 'failed' | 'auth_failed', or null if none on record.
  verdict: string | null;
  // Analytics endpoints reported a scope denial on the most recent run — GMV and
  // orders are unaffected; only traffic/conversion metrics are unavailable.
  analyticsScopeMissing: boolean;
}

type ConnStatusRow = {
  endpoint: string;
  status: string;
  started_at: string;
  finished_at: string | null;
};

type ConnStatusDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => {
        order: (
          col: string,
          opts: { ascending: boolean }
        ) => {
          limit: (n: number) => Promise<{ data: ConnStatusRow[] | null; error: unknown }>;
        };
      };
    };
  };
};

// The analytics endpoints whose scope denial must NOT redden the connection.
const ANALYTICS_ENDPOINTS = new Set<string>(["shop_performance", "product_performance"]);

// Read the org's recent sync-run rows once and derive the honest connection
// status for the Settings page. Never throws — any error yields a calm null
// verdict so the page renders "never synced" rather than crashing.
export async function getConnectionSyncStatus(orgId: string): Promise<ConnectionSyncStatus> {
  const empty: ConnectionSyncStatus = {
    lastSyncedAt: null,
    verdict: null,
    analyticsScopeMissing: false,
  };
  try {
    const svc = createServiceRoleClient() as unknown as ConnStatusDb;
    const { data, error } = await svc
      .from("tiktok_sync_runs")
      .select("endpoint, status, started_at, finished_at")
      .eq("org_id", orgId)
      // A generous window so both the newest run_summary and the newest analytics
      // steps of the latest run are in view (one run writes ~1 summary + N×4 steps).
      .order("started_at", { ascending: false })
      .limit(50);
    if (error || !data || !data.length) return empty;

    const summary = data.find((r) => r.endpoint === RUN_SUMMARY_ENDPOINT) ?? null;
    // Newest analytics step overall; if it skipped for a missing scope, the
    // connection is synced but analytics is unavailable.
    const latestAnalytics = data.find((r) => ANALYTICS_ENDPOINTS.has(r.endpoint)) ?? null;

    const newest = data[0];
    return {
      lastSyncedAt: newest.finished_at ?? newest.started_at ?? null,
      verdict: summary?.status ?? null,
      analyticsScopeMissing: latestAnalytics?.status === ANALYTICS_SKIPPED_STATUS,
    };
  } catch (e) {
    console.error("[tiktok] getConnectionSyncStatus threw", e);
    return empty;
  }
}

// --- Health-monitor reads ---------------------------------------------------

export interface LatestRunSummary {
  status: string;
  started_at: string;
  finished_at: string | null;
}

type RunSummaryDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => {
        eq: (
          col: string,
          v: string
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean }
          ) => {
            limit: (n: number) => Promise<{ data: LatestRunSummary[] | null; error: unknown }>;
          };
        };
      };
    };
  };
};

// The newest run_summary row for an org — the health monitor's single source of
// truth for "did the last scheduled sync land, and was it healthy?". Returns
// null when the org has never produced a run summary (treated as MISSING).
export async function getLatestRunSummary(orgId: string): Promise<LatestRunSummary | null> {
  try {
    const svc = createServiceRoleClient() as unknown as RunSummaryDb;
    const { data, error } = await svc
      .from("tiktok_sync_runs")
      .select("status, started_at, finished_at")
      .eq("org_id", orgId)
      .eq("endpoint", RUN_SUMMARY_ENDPOINT)
      .order("started_at", { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    return data[0];
  } catch (e) {
    console.error("[tiktok] getLatestRunSummary threw", e);
    return null;
  }
}

type OrgIdsDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => Promise<{ data: { org_id: string }[] | null; error: unknown }>;
    };
  };
};

// The distinct orgs that have at least one ACTIVE shop — i.e. the orgs the
// scheduled sync is expected to run for. The health monitor iterates these.
export async function listSyncOrgIds(): Promise<string[]> {
  try {
    const svc = createServiceRoleClient() as unknown as OrgIdsDb;
    const { data, error } = await svc
      .from("tiktok_shops")
      .select("org_id")
      .eq("status", "active");
    if (error || !data) {
      if (error) console.error("[tiktok] listSyncOrgIds failed", error);
      return [];
    }
    return Array.from(new Set(data.map((r) => r.org_id).filter((id): id is string => !!id)));
  } catch (e) {
    console.error("[tiktok] listSyncOrgIds threw", e);
    return [];
  }
}
