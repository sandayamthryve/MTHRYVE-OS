import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  CANVA_TOKEN_URL,
  canvaBasicAuthHeader,
  isCanvaConfigured,
} from "@/lib/canva/config";

// The Canva token vault: read/write helpers for public.canva_connections.
//
// SECURITY: that table has RLS on with NO policy (locked), so it is reachable
// ONLY through the service-role client below — never the user/anon client. One
// row per org (unique org_id). Access/refresh tokens live here and MUST NEVER
// leave the server: the "status" helper returns only whether a connection
// exists, never the tokens themselves.

// Shape of the Canva token endpoint's success response.
interface CanvaTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number; // seconds
  scope?: string;
}

// The columns we read back from the vault.
interface CanvaConnectionRow {
  org_id: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null; // ISO timestamptz
  scope: string | null;
  canva_user_id: string | null;
}

// Refresh a little early so a token that's about to expire mid-request still
// gets rotated rather than rejected downstream.
const EXPIRY_SKEW_MS = 60_000;

// Minimal query-builder shim: canva_connections isn't in the generated Supabase
// types (same idiom as content_items elsewhere in the app). RLS is irrelevant
// here — this is the service-role client — but the cast keeps TS happy.
type VaultDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        col: string,
        v: string
      ) => { maybeSingle: () => Promise<{ data: CanvaConnectionRow | null; error: unknown }> };
    };
    upsert: (
      v: Record<string, unknown>,
      opts: { onConflict: string }
    ) => Promise<{ error: unknown }>;
    update: (v: Record<string, unknown>) => {
      eq: (col: string, v: string) => Promise<{ error: unknown }>;
    };
  };
};

function vault(): VaultDb {
  return createServiceRoleClient() as unknown as VaultDb;
}

// --- Token endpoint calls ---------------------------------------------------

// Exchange an authorization code (+ PKCE verifier) for tokens. Called once from
// the OAuth callback. The redirect_uri MUST be the exact same value the connect
// route sent to the authorize endpoint, so the caller passes it in rather than
// us re-deriving it here. Returns null on any failure (caller surfaces a
// friendly, diagnosable message). The token endpoint's HTTP status is always
// logged, and the response body is logged on any non-200.
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<CanvaTokenResponse | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });
    const res = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        // Confidential client auth via HTTP Basic (client_id:client_secret).
        Authorization: canvaBasicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    console.info("[canva] token exchange status", res.status);
    if (!res.ok) {
      console.error("[canva] token exchange failed", res.status, await safeText(res));
      return null;
    }
    return (await res.json()) as CanvaTokenResponse;
  } catch (e) {
    console.error("[canva] token exchange threw", e);
    return null;
  }
}

// Trade a refresh_token for a fresh access token. Canva may rotate the
// refresh_token, so callers persist whatever comes back.
async function refreshTokens(refreshToken: string): Promise<CanvaTokenResponse | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: canvaBasicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      console.error("[canva] token refresh failed", res.status, await safeText(res));
      return null;
    }
    return (await res.json()) as CanvaTokenResponse;
  } catch (e) {
    console.error("[canva] token refresh threw", e);
    return null;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// --- Vault reads / writes ---------------------------------------------------

// Persist (insert or update) the org's single connection row. On conflict with
// an existing org_id we overwrite the tokens — reconnecting always wins.
export async function upsertCanvaConnection(row: {
  orgId: string;
  connectedBy: string;
  tokens: CanvaTokenResponse;
  canvaUserId: string | null;
}): Promise<boolean> {
  const { tokens } = row;
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;
  const { error } = await vault()
    .from("canva_connections")
    .upsert(
      {
        org_id: row.orgId,
        connected_by: row.connectedBy,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        token_expires_at: expiresAt,
        scope: tokens.scope ?? null,
        canva_user_id: row.canvaUserId,
      },
      { onConflict: "org_id" }
    );
  if (error) {
    console.error("[canva] vault upsert failed", error);
    return false;
  }
  return true;
}

// Whether this org has a Canva connection — the ONLY vault fact safe to hand to
// the browser. Never returns tokens. Any error (incl. missing config) → false.
export async function getCanvaConnectionStatus(
  orgId: string
): Promise<{ connected: boolean; canvaUserId: string | null }> {
  if (!isCanvaConfigured()) return { connected: false, canvaUserId: null };
  try {
    const { data, error } = await vault()
      .from("canva_connections")
      .select("org_id, access_token, refresh_token, token_expires_at, scope, canva_user_id")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error || !data) return { connected: false, canvaUserId: null };
    return { connected: true, canvaUserId: data.canva_user_id ?? null };
  } catch (e) {
    console.error("[canva] status lookup threw", e);
    return { connected: false, canvaUserId: null };
  }
}

// Return a valid access token for the org, refreshing (and persisting the new
// tokens) if the stored one has expired. Returns null when there's no
// connection, config is missing, or a refresh fails — callers must handle null
// and never crash.
export async function getCanvaToken(orgId: string): Promise<string | null> {
  if (!isCanvaConfigured()) return null;
  try {
    const { data, error } = await vault()
      .from("canva_connections")
      .select("org_id, access_token, refresh_token, token_expires_at, scope, canva_user_id")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error || !data) return null;

    const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
    const stillValid = expiresAt - EXPIRY_SKEW_MS > Date.now();
    if (stillValid && data.access_token) return data.access_token;

    // Expired (or unknown expiry) → refresh if we can.
    if (!data.refresh_token) return stillValid ? data.access_token : null;
    const refreshed = await refreshTokens(data.refresh_token);
    if (!refreshed) return null;

    const newExpiresAt =
      typeof refreshed.expires_in === "number"
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : null;
    const { error: updateError } = await vault()
      .from("canva_connections")
      .update({
        access_token: refreshed.access_token,
        // Canva rotates the refresh token; keep the old one only if none returned.
        refresh_token: refreshed.refresh_token ?? data.refresh_token,
        token_expires_at: newExpiresAt,
        scope: refreshed.scope ?? data.scope,
      })
      .eq("org_id", orgId);
    if (updateError) console.error("[canva] persisting refreshed token failed", updateError);
    return refreshed.access_token;
  } catch (e) {
    console.error("[canva] getCanvaToken threw", e);
    return null;
  }
}
