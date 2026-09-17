// Canva Connect API configuration — endpoints, OAuth constants and a single
// "is this integration even set up?" check. Kept in one place so the connect
// route, the callback, the token vault and the UI all agree.
//
// The Connect API uses OAuth 2.0 Authorization Code + PKCE (SHA-256). Client
// authentication at the token endpoint uses the confidential client secret, so
// every token call MUST run server-side (Canva's CORS blocks browser calls).
// See https://www.canva.dev/docs/connect/authentication/.

// OAuth + REST endpoints (per the Canva Connect API docs).
export const CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
export const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
export const CANVA_API_BASE = "https://api.canva.com/rest/v1";

// The default redirect URI registered with the Canva integration. It must match
// byte-for-byte in the authorize request and the token exchange. Prefer
// canvaRedirectUri(request.url) below — this const is only the last-resort base
// for building return URLs when no request is in hand.
export const CANVA_REDIRECT_URI = "https://mthryve-os.vercel.app/api/canva/callback";

// The redirect_uri the OAuth flow actually uses, resolved at request time so it
// tracks the real deployment origin instead of a hardcoded host. An explicit
// CANVA_REDIRECT_URI env var wins (for when the registered URI differs from the
// request origin — e.g. a stable production domain behind preview URLs);
// otherwise we derive it from the incoming request's own origin. The connect
// route (authorize) and the callback (token exchange) MUST compute this the same
// way so the two redirect_uri values match byte-for-byte.
export function canvaRedirectUri(requestUrl: string): string {
  const fromEnv = process.env.CANVA_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  return `${new URL(requestUrl).origin}/api/canva/callback`;
}

// Space-delimited scopes we request. Read + write designs, read assets (to pull
// a thumbnail), and read the connecting user's profile.
export const CANVA_SCOPES =
  "design:content:read design:content:write asset:read profile:read";

// The short-lived cookies that carry PKCE state across the redirect to Canva
// and back. httpOnly + SameSite=Lax so they survive the top-level GET return.
export const CANVA_VERIFIER_COOKIE = "canva_pkce_verifier";
export const CANVA_STATE_COOKIE = "canva_oauth_state";

export function canvaClientId(): string | undefined {
  return process.env.CANVA_CLIENT_ID;
}
export function canvaClientSecret(): string | undefined {
  return process.env.CANVA_CLIENT_SECRET;
}

// True only when every piece needed to run the flow is present: the OAuth
// client credentials AND the service-role key that unlocks the token vault.
// The UI uses this to fall back to a calm "not set up yet" state instead of
// throwing when an env var is missing.
export function isCanvaConfigured(): boolean {
  return Boolean(
    process.env.CANVA_CLIENT_ID &&
      process.env.CANVA_CLIENT_SECRET &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.NEXT_PUBLIC_SUPABASE_URL
  );
}

// HTTP Basic auth header for the confidential client at the token endpoint.
export function canvaBasicAuthHeader(): string {
  const raw = `${canvaClientId() ?? ""}:${canvaClientSecret() ?? ""}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}
