import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  TIKTOK_TOKEN_REFRESH_URL,
  tiktokAppKey,
  tiktokAppSecret,
  tiktokTokenRefreshWindowHours,
  isTikTokConfigured,
} from "@/lib/tiktok/config";

// The TikTok Shop token vault: read/write helpers for public.tiktok_connections
// and public.tiktok_shops.
//
// SECURITY: both tables have RLS ON with NO policy (locked), so they are
// reachable ONLY through the service-role client below — never the user/anon
// client. Access/refresh tokens live in tiktok_connections and MUST NEVER leave
// the server: the "status" helpers (getConnection / listShops) return only
// non-secret display fields, never the tokens themselves.
//
// One connection row per (org_id, open_id) — a merchant may authorize more than
// one seller account under an org, so open_id is part of the key. Shops are
// keyed (org_id, shop_id) and hang off a connection via connection_id.

// Refresh a little early: if the access token expires within this window we
// rotate it now rather than let a call mid-flight get rejected.
const EXPIRY_SKEW_MS = 5 * 60_000; // 5 minutes

// --- Types ------------------------------------------------------------------

// A shop as returned by the authorization/shops read, normalized to our columns.
export interface TikTokShopInput {
  id: string; // TikTok shop_id
  cipher?: string | null; // shop_cipher (needed for later business calls)
  name?: string | null;
  region?: string | null;
}

// The token/refresh success payload (data object).
interface TikTokRefreshData {
  access_token?: string;
  refresh_token?: string;
  access_token_expire_in?: number; // absolute unix seconds
  refresh_token_expire_in?: number; // absolute unix seconds
  open_id?: string;
  seller_name?: string;
  granted_scopes?: string[];
}

// The full connection row (INCLUDING tokens) — read only inside this module,
// never returned to a caller that could leak it to the browser.
interface TikTokConnectionRow {
  id: string;
  org_id: string;
  open_id: string;
  seller_name: string | null;
  region: string | null;
  access_token: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null; // ISO timestamptz
  refresh_token_expires_at: string | null;
  granted_scopes: string[] | null;
  status: string | null;
}

// The safe subset handed to the UI — NO tokens.
export interface TikTokConnectionStatus {
  id: string;
  open_id: string;
  seller_name: string | null;
  region: string | null;
  granted_scopes: string[] | null;
  status: string | null;
}

export interface TikTokShopStatus {
  shop_id: string;
  shop_name: string | null;
  region: string | null;
}

// Minimal service-role query-builder shim: the tiktok_* tables aren't in the
// generated Supabase types (same idiom as lib/canva/vault.ts). RLS is irrelevant
// here — this is the service-role client — but the cast keeps TS happy.
type VaultDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => {
        eq: (col: string, v: string) => {
          maybeSingle: () => Promise<{ data: TikTokConnectionRow | null; error: unknown }>;
        };
        maybeSingle: () => Promise<{ data: TikTokConnectionRow | null; error: unknown }>;
        order: (
          col: string,
          opts: { ascending: boolean }
        ) => Promise<{ data: unknown[] | null; error: unknown }>;
      };
    };
    upsert: (
      v: Record<string, unknown> | Record<string, unknown>[],
      opts: { onConflict: string }
    ) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => {
      eq: (col: string, v: string) => {
        eq: (col: string, v: string) => Promise<{ error: unknown }>;
      };
    };
  };
};

function vault(): VaultDb {
  return createServiceRoleClient() as unknown as VaultDb;
}

// --- Writes -----------------------------------------------------------------

// Persist (insert or update) a connection. On conflict with an existing
// (org_id, open_id) we overwrite the tokens — reconnecting always wins.
// Expiry fields are passed already-converted to ISO timestamptz by the caller
// (the callback turns TikTok's absolute unix seconds into ISO). Returns the
// connection id on success, null on failure (fail-loud logged).
export async function upsertConnection(row: {
  org_id: string;
  open_id: string;
  seller_name: string | null;
  region: string | null;
  access_token: string;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  granted_scopes: string[] | null;
  connected_by: string | null;
}): Promise<string | null> {
  try {
    const svc = createServiceRoleClient() as unknown as {
      from: (t: string) => {
        upsert: (
          v: Record<string, unknown>,
          opts: { onConflict: string }
        ) => {
          select: (c: string) => {
            single: () => Promise<{ data: { id: string } | null; error: unknown }>;
          };
        };
      };
    };
    const { data, error } = await svc
      .from("tiktok_connections")
      .upsert(
        {
          org_id: row.org_id,
          open_id: row.open_id,
          seller_name: row.seller_name,
          region: row.region,
          access_token: row.access_token,
          refresh_token: row.refresh_token,
          access_token_expires_at: row.access_token_expires_at,
          refresh_token_expires_at: row.refresh_token_expires_at,
          granted_scopes: row.granted_scopes,
          connected_by: row.connected_by,
          status: "active",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "org_id,open_id" }
      )
      .select("id")
      .single();
    if (error || !data) {
      console.error("[tiktok] vault upsertConnection failed", error);
      return null;
    }
    return data.id;
  } catch (e) {
    console.error("[tiktok] vault upsertConnection threw", e);
    return null;
  }
}

// Persist the shops authorized under a connection. Upserts on (org_id, shop_id)
// so re-running the callback refreshes shop names/ciphers in place. Returns the
// number of shops written (0 on failure — the caller keeps the connection and
// surfaces a soft ?tiktok_warn=shops_fetch_failed rather than failing hard).
export async function upsertShops(
  connection_id: string,
  org_id: string,
  shops: TikTokShopInput[]
): Promise<number> {
  if (!shops.length) return 0;
  try {
    const rows = shops
      .filter((s) => s.id)
      .map((s) => ({
        org_id,
        connection_id,
        shop_id: s.id,
        shop_cipher: s.cipher ?? null,
        shop_name: s.name ?? null,
        region: s.region ?? null,
        status: "active",
        updated_at: new Date().toISOString(),
      }));
    if (!rows.length) return 0;
    const { error } = await vault()
      .from("tiktok_shops")
      .upsert(rows, { onConflict: "org_id,shop_id" });
    if (error) {
      console.error("[tiktok] vault upsertShops failed", error);
      return 0;
    }
    return rows.length;
  } catch (e) {
    console.error("[tiktok] vault upsertShops threw", e);
    return 0;
  }
}

// --- Reads (status display — NEVER returns tokens) --------------------------

// The org's connections, tokens stripped, for status display. Any error (incl.
// missing config) → empty list rather than a throw.
export async function getConnection(org_id: string): Promise<TikTokConnectionStatus | null> {
  if (!isTikTokConfigured()) return null;
  try {
    const svc = createServiceRoleClient() as unknown as {
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
              limit: (n: number) => Promise<{ data: TikTokConnectionRow[] | null; error: unknown }>;
            };
          };
        };
      };
    };
    const { data, error } = await svc
      .from("tiktok_connections")
      .select("id, open_id, seller_name, region, granted_scopes, status")
      .eq("org_id", org_id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || !data.length) return null;
    const r = data[0];
    return {
      id: r.id,
      open_id: r.open_id,
      seller_name: r.seller_name,
      region: r.region,
      granted_scopes: r.granted_scopes,
      status: r.status,
    };
  } catch (e) {
    console.error("[tiktok] getConnection threw", e);
    return null;
  }
}

// The org's authorized shops, for status display. No tokens exist on this table.
export async function listShops(org_id: string): Promise<TikTokShopStatus[]> {
  if (!isTikTokConfigured()) return [];
  try {
    const svc = createServiceRoleClient() as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (
            col: string,
            v: string
          ) => {
            order: (
              col: string,
              opts: { ascending: boolean }
            ) => Promise<{ data: TikTokShopStatus[] | null; error: unknown }>;
          };
        };
      };
    };
    const { data, error } = await svc
      .from("tiktok_shops")
      .select("shop_id, shop_name, region")
      .eq("org_id", org_id)
      .order("shop_name", { ascending: true });
    if (error || !data) return [];
    return data;
  } catch (e) {
    console.error("[tiktok] listShops threw", e);
    return [];
  }
}

// --- Token-expiry monitoring ------------------------------------------------

// A connection whose access token expires soon — the health monitor warns
// leadership BEFORE it lapses (once lapsed, the next sync bounces to /login).
export interface ExpiringConnection {
  org_id: string;
  open_id: string;
  seller_name: string | null;
  access_token_expires_at: string; // ISO timestamptz (never null here)
}

// Every ACTIVE connection whose access token expires within `withinHours` from
// now (and hasn't already lapsed further back than we care to report — an
// already-expired token still surfaces, since it's the most urgent). Service-role
// only; returns display fields, NEVER the token itself.
export async function listExpiringConnections(
  withinHours: number
): Promise<ExpiringConnection[]> {
  if (!isTikTokConfigured()) return [];
  try {
    const svc = createServiceRoleClient() as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (
            col: string,
            v: string
          ) => {
            not: (
              col: string,
              op: string,
              v: null
            ) => {
              lte: (
                col: string,
                v: string
              ) => Promise<{ data: ExpiringConnection[] | null; error: unknown }>;
            };
          };
        };
      };
    };
    const cutoff = new Date(Date.now() + withinHours * 3600_000).toISOString();
    const { data, error } = await svc
      .from("tiktok_connections")
      .select("org_id, open_id, seller_name, access_token_expires_at")
      .eq("status", "active")
      .not("access_token_expires_at", "is", null)
      .lte("access_token_expires_at", cutoff);
    if (error || !data) {
      if (error) console.error("[tiktok] listExpiringConnections failed", error);
      return [];
    }
    return data;
  } catch (e) {
    console.error("[tiktok] listExpiringConnections threw", e);
    return [];
  }
}

// --- Valid access token (with refresh) --------------------------------------

// Return a valid access token for a specific (org_id, open_id) connection,
// refreshing (and persisting the rotated tokens) if the stored one expires
// within the skew window. Returns null when there's no connection, config is
// missing, the refresh token is gone/expired, or a refresh fails — callers must
// handle null and never crash. Tokens NEVER leave the server via this path; it's
// for server-side business calls only.
export async function getValidAccessToken(
  org_id: string,
  open_id: string
): Promise<string | null> {
  if (!isTikTokConfigured()) return null;
  try {
    const svc = createServiceRoleClient() as unknown as {
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
              maybeSingle: () => Promise<{ data: TikTokConnectionRow | null; error: unknown }>;
            };
          };
        };
      };
    };
    const { data, error } = await svc
      .from("tiktok_connections")
      .select(
        "id, org_id, open_id, seller_name, region, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, granted_scopes, status"
      )
      .eq("org_id", org_id)
      .eq("open_id", open_id)
      .maybeSingle();
    if (error || !data) {
      console.error("[tiktok] getValidAccessToken: no connection", { org_id, open_id, error });
      return null;
    }

    const expiresAt = data.access_token_expires_at
      ? new Date(data.access_token_expires_at).getTime()
      : 0;
    const stillValid = expiresAt - EXPIRY_SKEW_MS > Date.now();
    if (stillValid && data.access_token) return data.access_token;

    // Expiring/expired → refresh if we still have a refresh token.
    if (!data.refresh_token) {
      console.error("[tiktok] getValidAccessToken: token expiring and no refresh_token", {
        org_id,
        open_id,
      });
      return null;
    }
    console.info("[tiktok] refreshing access token", { org_id, open_id });
    const newToken = await refreshAndPersist(data);
    return newToken;
  } catch (e) {
    console.error("[tiktok] getValidAccessToken threw", e);
    return null;
  }
}

// Trade a connection's refresh_token for a fresh access token and PERSIST the
// rotated tokens onto its tiktok_connections row (keyed org_id + open_id).
// Shared by getValidAccessToken (lazy, at data-pull time) and the proactive
// refresh pass (eager, independent of the data pull) so both write identical
// state. Returns the new access token, or null if there's no refresh token or
// the refresh call fails. NEVER logs a token value.
async function refreshAndPersist(conn: {
  org_id: string;
  open_id: string;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  refresh_token: string | null;
  granted_scopes: string[] | null;
}): Promise<string | null> {
  if (!conn.refresh_token) return null;
  const refreshed = await refreshTokens(conn.refresh_token);
  if (!refreshed?.access_token) return null;

  const newAccessExpiry =
    typeof refreshed.access_token_expire_in === "number"
      ? new Date(refreshed.access_token_expire_in * 1000).toISOString()
      : conn.access_token_expires_at;
  const newRefreshExpiry =
    typeof refreshed.refresh_token_expire_in === "number"
      ? new Date(refreshed.refresh_token_expire_in * 1000).toISOString()
      : conn.refresh_token_expires_at;

  const updater = createServiceRoleClient() as unknown as {
    from: (t: string) => {
      update: (v: Record<string, unknown>) => {
        eq: (col: string, v: string) => {
          eq: (col: string, v: string) => Promise<{ error: unknown }>;
        };
      };
    };
  };
  const { error: updateError } = await updater
    .from("tiktok_connections")
    .update({
      access_token: refreshed.access_token,
      // TikTok rotates the refresh token; keep the old one only if none came back.
      refresh_token: refreshed.refresh_token ?? conn.refresh_token,
      access_token_expires_at: newAccessExpiry,
      refresh_token_expires_at: newRefreshExpiry,
      granted_scopes: refreshed.granted_scopes ?? conn.granted_scopes,
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", conn.org_id)
    .eq("open_id", conn.open_id);
  if (updateError) {
    console.error("[tiktok] persisting refreshed token failed", updateError);
    // The refresh itself succeeded even if the write logged an error; surface the
    // token so an in-flight caller can still use it. The next run re-refreshes.
  }
  return refreshed.access_token;
}

// --- Proactive (decoupled) token refresh ------------------------------------

// PII-free, token-free outcome of the proactive refresh pass for one connection.
export interface ProactiveRefreshOutcome {
  org_id: string;
  open_id: string;
  seller_name: string | null;
  // 'refreshed'   — token was near/over expiry and we rotated it successfully.
  // 'skipped'     — token still has plenty of life; nothing to do.
  // 'no_refresh'  — near expiry but no usable refresh_token (needs a reconnect).
  // 'failed'      — near expiry, tried to refresh, TikTok rejected it.
  result: "refreshed" | "skipped" | "no_refresh" | "failed";
  // Hours until the (pre-refresh) access token expired, for the run log. Rounded.
  hoursToExpiry: number | null;
}

export interface ProactiveRefreshSummary {
  considered: number; // active connections examined
  refreshed: number; // tokens actually rotated
  failed: number; // near expiry but refresh failed / no refresh token
  outcomes: ProactiveRefreshOutcome[];
}

// PROACTIVELY refresh every ACTIVE connection whose access token expires within
// `withinHours` (default from TIKTOK_TOKEN_REFRESH_WINDOW_HOURS), using its stored
// refresh_token — INDEPENDENT of whether that shop's data pull will succeed. This
// is the decoupling the sync needed: previously a token was only ever rotated as a
// side effect of getValidAccessToken during the pull, so a shop whose pull kept
// auth-failing never got its token renewed and stayed stuck. Running this pass up
// front means such a shop's token is renewed regardless, un-sticking it.
//
// Idempotent and safe to run every sync: a token with plenty of life is skipped.
// Optionally scoped to one org (a manual "Sync now"); otherwise all orgs. Returns
// a token-free summary. NEVER logs or returns a token value.
export async function refreshExpiringConnections(
  orgId?: string,
  withinHours: number = tiktokTokenRefreshWindowHours()
): Promise<ProactiveRefreshSummary> {
  const summary: ProactiveRefreshSummary = {
    considered: 0,
    refreshed: 0,
    failed: 0,
    outcomes: [],
  };
  if (!isTikTokConfigured()) return summary;

  try {
    const svc = createServiceRoleClient() as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (
            col: string,
            v: string
          ) => {
            eq: (
              col: string,
              v: string
            ) => Promise<{ data: TikTokConnectionRow[] | null; error: unknown }>;
          } & Promise<{ data: TikTokConnectionRow[] | null; error: unknown }>;
        };
      };
    };
    const cols =
      "id, org_id, open_id, seller_name, region, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, granted_scopes, status";
    const base = svc.from("tiktok_connections").select(cols).eq("status", "active");
    const { data, error } = orgId ? await base.eq("org_id", orgId) : await base;
    if (error || !data) {
      if (error) console.error("[tiktok] refreshExpiringConnections query failed", error);
      return summary;
    }

    const now = Date.now();
    const cutoff = now + withinHours * 3600_000;
    for (const conn of data) {
      summary.considered += 1;
      const expMs = conn.access_token_expires_at
        ? new Date(conn.access_token_expires_at).getTime()
        : 0;
      const hoursToExpiry =
        expMs > 0 ? Math.round((expMs - now) / 3600_000) : null;

      // Not near expiry yet (and we have a token) → leave it. `expMs === 0`
      // (missing/unparseable expiry) is treated as needs-refresh so a connection
      // in an unknown state gets renewed rather than silently ignored.
      if (expMs > cutoff && conn.access_token) {
        summary.outcomes.push({
          org_id: conn.org_id,
          open_id: conn.open_id,
          seller_name: conn.seller_name,
          result: "skipped",
          hoursToExpiry,
        });
        continue;
      }

      if (!conn.refresh_token) {
        summary.failed += 1;
        summary.outcomes.push({
          org_id: conn.org_id,
          open_id: conn.open_id,
          seller_name: conn.seller_name,
          result: "no_refresh",
          hoursToExpiry,
        });
        console.error("[tiktok] proactive refresh: no refresh_token", {
          org_id: conn.org_id,
          open_id: conn.open_id,
        });
        continue;
      }

      const newToken = await refreshAndPersist(conn);
      if (newToken) {
        summary.refreshed += 1;
        summary.outcomes.push({
          org_id: conn.org_id,
          open_id: conn.open_id,
          seller_name: conn.seller_name,
          result: "refreshed",
          hoursToExpiry,
        });
        console.info("[tiktok] proactive refresh: rotated token", {
          org_id: conn.org_id,
          open_id: conn.open_id,
          hoursToExpiry,
        });
      } else {
        summary.failed += 1;
        summary.outcomes.push({
          org_id: conn.org_id,
          open_id: conn.open_id,
          seller_name: conn.seller_name,
          result: "failed",
          hoursToExpiry,
        });
        console.error("[tiktok] proactive refresh: refresh failed", {
          org_id: conn.org_id,
          open_id: conn.open_id,
        });
      }
    }
    return summary;
  } catch (e) {
    console.error("[tiktok] refreshExpiringConnections threw", e);
    return summary;
  }
}

// Trade a refresh_token for fresh tokens. UNSIGNED — auth is app_key/app_secret
// in the query. TikTok returns { code, message, data }; code 0 means success.
async function refreshTokens(refreshToken: string): Promise<TikTokRefreshData | null> {
  const appKey = tiktokAppKey();
  const appSecret = tiktokAppSecret();
  if (!appKey || !appSecret) return null;
  try {
    const url = new URL(TIKTOK_TOKEN_REFRESH_URL);
    url.searchParams.set("app_key", appKey);
    url.searchParams.set("app_secret", appSecret);
    url.searchParams.set("refresh_token", refreshToken);
    url.searchParams.set("grant_type", "refresh_token");
    const res = await fetch(url, { method: "GET" });
    const json = (await res.json().catch(() => null)) as {
      code?: number;
      message?: string;
      data?: TikTokRefreshData;
    } | null;
    if (!res.ok || !json || json.code !== 0 || !json.data?.access_token) {
      console.error("[tiktok] token refresh failed", res.status, json?.code, json?.message);
      return null;
    }
    return json.data;
  } catch (e) {
    console.error("[tiktok] token refresh threw", e);
    return null;
  }
}
