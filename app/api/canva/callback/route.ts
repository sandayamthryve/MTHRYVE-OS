import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireRole } from "@/lib/auth/session";
import {
  CANVA_API_BASE,
  CANVA_VERIFIER_COOKIE,
  CANVA_STATE_COOKIE,
  canvaRedirectUri,
} from "@/lib/canva/config";
import { exchangeCodeForTokens, upsertCanvaConnection } from "@/lib/canva/vault";

export const runtime = "nodejs";
// Read the OAuth env vars (incl. Vercel "Sensitive" runtime-only vars) fresh on
// every request rather than at build time.
export const dynamic = "force-dynamic";

// GET /api/canva/callback — finish the Canva Connect OAuth flow.
//
// Canva redirects here with ?code&state. We verify the state against the cookie
// set in /connect, exchange the code (+ PKCE verifier) for tokens, best-effort
// look up the Canva user id, upsert the org's single vault row via the
// service-role client, then land back on the calendar. Every failure funnels to
// a NAMED ?canva_error=<reason> flag the page turns into a clear red banner, and
// success lands on ?canva_connected=1 — so the flow is never silent.

// Best-effort Canva user id (needs profile:read). Null on any hiccup — it's
// metadata, not something to block a successful connection over.
async function fetchCanvaUserId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${CANVA_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { team_user?: { user_id?: string } };
    return data.team_user?.user_id ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const profile = await requireRole(["ceo", "coo", "department_head"]);

  const origin = new URL(request.url).origin;
  // Must match the redirect_uri sent to /authorize byte-for-byte.
  const redirectUri = canvaRedirectUri(request.url);

  // Every outcome returns to the Creative Studio Plan tab; it renders the flag.
  const back = (query: string): NextResponse =>
    NextResponse.redirect(new URL(`/creative-studio?tab=plan&${query}`, origin));

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  const oauthError = searchParams.get("error");

  const cookieStore = cookies();
  const verifier = cookieStore.get(CANVA_VERIFIER_COOKIE)?.value;
  const storedState = cookieStore.get(CANVA_STATE_COOKIE)?.value;

  // Clear the one-shot cookies no matter how this turns out.
  const clear = (res: NextResponse) => {
    res.cookies.set(CANVA_VERIFIER_COOKIE, "", { path: "/", maxAge: 0 });
    res.cookies.set(CANVA_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };

  // User denied, or Canva returned an error — surface exactly what it said.
  if (oauthError) {
    console.error("[canva] callback oauth error", oauthError);
    return clear(back(`canva_error=${encodeURIComponent(oauthError)}`));
  }

  // The PKCE verifier cookie is required to complete the exchange.
  if (!verifier) return clear(back("canva_error=missing_verifier"));

  // Canva must return an authorization code.
  if (!code) return clear(back("canva_error=missing_code"));

  // CSRF: the returned state must match the cookie we set in /connect.
  if (!storedState || !returnedState || storedState !== returnedState) {
    return clear(back("canva_error=invalid_state"));
  }

  // Token exchange — belt-and-suspenders try/catch (the vault helper also
  // guards internally). redirect() throws, so it stays outside this block.
  let tokens = null;
  try {
    tokens = await exchangeCodeForTokens(code, verifier, redirectUri);
  } catch (e) {
    console.error("[canva] callback exchange threw", e);
    tokens = null;
  }
  if (!tokens?.access_token) return clear(back("canva_error=exchange_failed"));

  const canvaUserId = await fetchCanvaUserId(tokens.access_token);

  const saved = await upsertCanvaConnection({
    orgId: profile.org_id,
    connectedBy: profile.id,
    tokens,
    canvaUserId,
  });
  if (!saved) return clear(back("canva_error=save_failed"));

  return clear(back("canva_connected=1"));
}
