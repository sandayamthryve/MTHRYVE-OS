import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "crypto";
import { requireRole } from "@/lib/auth/session";
import {
  CANVA_AUTHORIZE_URL,
  CANVA_SCOPES,
  CANVA_VERIFIER_COOKIE,
  CANVA_STATE_COOKIE,
  canvaRedirectUri,
} from "@/lib/canva/config";

export const runtime = "nodejs";
// Read the OAuth env vars (incl. Vercel "Sensitive" runtime-only vars) fresh on
// every request rather than at build time.
export const dynamic = "force-dynamic";

// GET /api/canva/connect — start the Canva Connect OAuth flow.
//
// Only leadership + department heads may connect the org's Canva account. We
// generate a PKCE verifier/challenge (SHA-256) and a CSRF state, stash both in
// short-lived httpOnly cookies, then redirect the user to Canva's authorize
// page. The callback reads the cookies back to complete the exchange.
//
// Self-diagnosing by design: env is read at call time, the exact redirect_uri
// and authorize host are logged (never the secret), and a missing client id
// bounces straight back to the calendar with a named, actionable error flag
// instead of dead-ending on Canva.

// URL-safe base64 (base64url) without padding — the encoding PKCE requires.
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function GET(request: NextRequest) {
  // Role gate first (redirects non-leadership home before any secrets touch).
  await requireRole(["ceo", "coo", "department_head"]);

  const origin = new URL(request.url).origin;

  // Read env at call time so runtime-only "Sensitive" Vercel vars are visible.
  const clientId = process.env.CANVA_CLIENT_ID;
  if (!clientId) {
    // Don't dead-end on Canva — bounce back with a named reason the page turns
    // into a clear "which var is missing" message.
    return NextResponse.redirect(
      new URL("/creative-studio?tab=plan&canva_error=missing_client_id", origin)
    );
  }

  // The redirect_uri must match byte-for-byte in the authorize request and the
  // later token exchange; both compute it the same way from the request/env.
  const redirectUri = canvaRedirectUri(request.url);

  // PKCE: a high-entropy verifier (96 bytes → 128 base64url chars, within the
  // 43–128 spec range) and its SHA-256 challenge.
  const codeVerifier = base64url(randomBytes(96));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(24));

  const cookieStore = cookies();
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600, // 10 minutes — plenty for the round-trip, gone soon after.
  };
  cookieStore.set(CANVA_VERIFIER_COOKIE, codeVerifier, cookieOpts);
  cookieStore.set(CANVA_STATE_COOKIE, state, cookieOpts);

  const authorizeUrl = new URL(CANVA_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", CANVA_SCOPES);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);

  // Diagnostics: authorize host + the exact redirect_uri, NEVER the secret.
  console.info("[canva] connect →", {
    authorizeHost: authorizeUrl.host,
    redirectUri,
  });

  return NextResponse.redirect(authorizeUrl);
}
