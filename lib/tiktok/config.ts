// TikTok Shop Partner API configuration — endpoints, OAuth constants and a
// single "is this integration even set up?" check. Kept in one place so the
// connect route, the callback, the token vault and the UI all agree.
//
// The Partner flow is OAuth-like but TikTok's own dialect: the merchant
// authorizes your *service* (identified by TIKTOK_SERVICE_ID) at the Partner
// authorize page, TikTok redirects back to the URL registered in Partner
// Center with ?code&state, and you exchange that code for tokens at the
// UNSIGNED token/get endpoint. Every business API call (shops, and later
// product/order reads) is HMAC-SHA256 SIGNED. Client auth uses the app secret,
// so every token/business call MUST run server-side. Tokens never touch the
// browser (locked vault, service-role only).
//
// IMPORTANT (hard-won): read env at REQUEST time (functions below), never at
// module scope, so Vercel "Sensitive" runtime-only vars are visible per request
// rather than inlined as undefined at build time.
//
// ⚠️ TikTok versions these hosts/paths. Confirm each against Partner Center →
// your App → API guide before shipping; they are documented here as the current
// known-good values.

// --- Endpoints --------------------------------------------------------------

// Partner authorize page. The merchant lands here to grant the service access.
// Only service_id + state are passed; the redirect URL and scopes are what's
// registered on the service in Partner Center.
export const TIKTOK_AUTHORIZE_URL = "https://services.tiktokshop.com/open/authorize";

// Token endpoints — UNSIGNED (auth via app_key + app_secret in the query).
export const TIKTOK_TOKEN_GET_URL = "https://auth.tiktok-shops.com/api/v2/token/get";
export const TIKTOK_TOKEN_REFRESH_URL = "https://auth.tiktok-shops.com/api/v2/token/refresh";

// Business API host — every call here is SIGNED (see lib/tiktok/sign.ts).
export const TIKTOK_API_BASE = "https://open-api.tiktokglobalshop.com";

// The authorized-shops read (versioned path). The version is part of the signed
// string, so keep the const and the sign() path argument identical.
export const TIKTOK_SHOPS_PATH = "/authorization/202309/shops";

// --- Daily read-sync endpoints (all SIGNED business calls) ------------------
//
// ⚠️ The version prefix is part of the signed string — keep each const and the
// sign() `path` argument byte-identical, and CONFIRM every path/param against
// Partner Center → your App → API Documents before shipping (TikTok versions
// these independently; 202309+ are the current known-good major versions).
//
// ORDERS — Order API, "Search orders" (POST, JSON body of time filters). ACTIVE
// under the order scope granted at connect. Used to aggregate daily GMV / order
// count / units. We store ONLY the daily aggregate — never buyer names/addresses.
export const TIKTOK_ORDERS_SEARCH_PATH = "/order/202309/orders/search";

// SETTLEMENTS — Finance API, "Get statements" (GET). ACTIVE under the finance
// scope. Maps to gross / fee / refund / net per statement.
export const TIKTOK_FINANCE_STATEMENTS_PATH = "/finance/202309/statements";

// ANALYTICS — Data/Analytics API (GET). MAY 403 until the analytics scope is
// approved for the app; the sync treats a 403/unauthorized as a soft skip.
// Shop-level performance (visitors / page_views / conversion_rate) and
// per-product performance.
export const TIKTOK_ANALYTICS_SHOP_PATH = "/analytics/202405/shop/performance";
export const TIKTOK_ANALYTICS_PRODUCTS_PATH = "/analytics/202405/shop_products/performance";

// --- Env readers (call-time) ------------------------------------------------

export function tiktokAppKey(): string | undefined {
  return process.env.TIKTOK_APP_KEY?.trim() || undefined;
}
export function tiktokAppSecret(): string | undefined {
  return process.env.TIKTOK_APP_SECRET?.trim() || undefined;
}
export function tiktokServiceId(): string | undefined {
  return process.env.TIKTOK_SERVICE_ID?.trim() || undefined;
}

// Shared secret for the Vercel Cron trigger of the daily read-sync. OPTIONAL:
// when set, a request carrying `Authorization: Bearer <CRON_SECRET>` is allowed
// to run the sync without a user session (that's how Vercel Cron authenticates).
// When unset, only a signed-in leadership session can run the sync.
export function cronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}

// The machine bearer the GitHub Actions automation instance already holds (the same key it
// uses for POST /api/automation/opportunities). We ALSO accept it on the daily
// read-sync so a reliable GitHub Actions schedule trigger can drive the sync without minting
// a second secret — see the scheduler note in the sync route. Server-side only.
export function automationApiKey(): string | undefined {
  return process.env.AUTOMATION_API_KEY?.trim() || undefined;
}

// The default per-run pull window, in days, ending yesterday (Asia/Manila).
// Historically the sync pulled a single day; that meant tiktok_shop_performance
// only ever held ~a handful of days per shop, so every "monthly" GMV figure was
// extrapolated from a sliver. A ROLLING 30-day window (env-tunable) keeps a full
// month of true daily rows landed on every run — re-pulling a day is a harmless
// idempotent upsert. An explicit ?days=N / ?backfill=N on the request still wins.
export const DEFAULT_SYNC_WINDOW_DAYS = 30;
export function tiktokSyncWindowDays(): number {
  const raw = Number(process.env.TIKTOK_SYNC_WINDOW_DAYS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_SYNC_WINDOW_DAYS;
}

// How close to expiry (hours) an access token must be before the sync PROACTIVELY
// refreshes it — independent of whether that shop's data pull succeeds. Defaults
// to 48h, matching the health monitor's TOKEN_EXPIRY_WARN_HOURS so a token that
// trips the warning is renewed on the very next run instead of lapsing to /login.
// This is what un-sticks an auth-failing shop: the refresh no longer rides on a
// successful data pull.
export const DEFAULT_TOKEN_REFRESH_WINDOW_HOURS = 48;
export function tiktokTokenRefreshWindowHours(): number {
  const raw = Number(process.env.TIKTOK_TOKEN_REFRESH_WINDOW_HOURS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_TOKEN_REFRESH_WINDOW_HOURS;
}

// marketplace_shops.marketplace / marketplace_orders_daily provenance. The
// generic marketplace layer keys shops on (org_id, marketplace, external_shop_id);
// the CHECK constraint allows only 'tiktok_shop' | 'shopee' | 'lazada'.
export const MARKETPLACE_TIKTOK = "tiktok_shop";

// The redirect URI registered with the TikTok service. TikTok redirects the
// merchant back here after authorize; we don't send it in the authorize request
// (Partner Center owns it), but we surface it in /diag so a mismatch is easy to
// spot. An explicit env var wins; otherwise derive from the request origin.
export function tiktokRedirectUri(requestUrl: string): string {
  const fromEnv = process.env.TIKTOK_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  return `${new URL(requestUrl).origin}/api/integrations/tiktok/callback`;
}

// The short-lived cookie carrying CSRF state across the redirect to TikTok and
// back. httpOnly + SameSite=Lax so it survives the top-level GET return.
export const TIKTOK_STATE_COOKIE = "tiktok_oauth_state";

// --- Config gate ------------------------------------------------------------

// Which specific piece of configuration is missing, if any — so the UI can name
// the exact env var instead of a vague "not set up". Returns null when every
// piece needed to run the flow is present.
export function tiktokMissingConfig():
  | "app key"
  | "app secret"
  | "service id"
  | "service-role key"
  | "Supabase URL"
  | null {
  if (!process.env.TIKTOK_APP_KEY?.trim()) return "app key";
  if (!process.env.TIKTOK_APP_SECRET?.trim()) return "app secret";
  if (!process.env.TIKTOK_SERVICE_ID?.trim()) return "service id";
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return "service-role key";
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return "Supabase URL";
  return null;
}

// True only when every piece needed to run the flow is present: the app
// credentials + service id AND the service-role key that unlocks the vault.
export function isTikTokConfigured(): boolean {
  return tiktokMissingConfig() === null;
}
