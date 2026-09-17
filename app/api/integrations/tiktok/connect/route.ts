import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { requireRole } from "@/lib/auth/session";
import {
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_STATE_COOKIE,
  tiktokServiceId,
} from "@/lib/tiktok/config";

export const runtime = "nodejs";
// Read the OAuth env vars (incl. Vercel "Sensitive" runtime-only vars) fresh on
// every request rather than at build time.
export const dynamic = "force-dynamic";

// GET /api/integrations/tiktok/connect — start the TikTok Shop Partner
// authorization flow.
//
// Only leadership + department heads may connect the org's TikTok Shop. We mint
// a random CSRF state, stash it in a short-lived httpOnly cookie, then redirect
// the merchant to the Partner authorize page. Only service_id + state are sent;
// the redirect URL and scopes are configured on the service in Partner Center.
// The callback reads the cookie back to verify state.
//
// Self-diagnosing by design: env is read at call time, the authorize host is
// logged (NEVER the secret), and a missing service id bounces straight back to
// /settings with a named, actionable error flag instead of dead-ending on
// TikTok.
//
// ⚠️ Confirm TIKTOK_AUTHORIZE_URL against Partner Center → your App → API guide;
// TikTok versions the authorize base.

// URL-safe base64 (base64url) without padding — a compact random state.
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function GET(request: NextRequest) {
  // Role gate first (redirects non-leadership home before any secrets touch).
  await requireRole(["ceo", "coo", "department_head"]);

  const origin = new URL(request.url).origin;

  // Read env at call time so runtime-only "Sensitive" Vercel vars are visible.
  const serviceId = tiktokServiceId();
  if (!serviceId) {
    // Don't dead-end on TikTok — bounce back with a named reason the page turns
    // into a clear "which var is missing" message.
    console.error("[tiktok] connect aborted: TIKTOK_SERVICE_ID missing");
    return NextResponse.redirect(new URL("/settings?tiktok_error=missing_service_id", origin));
  }

  const state = base64url(randomBytes(24));

  const cookieStore = cookies();
  cookieStore.set(TIKTOK_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 minutes — plenty for the round-trip, gone soon after.
  });

  const authorizeUrl = new URL(TIKTOK_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("service_id", serviceId);
  authorizeUrl.searchParams.set("state", state);

  // Diagnostics: authorize host only, NEVER the secret or the service id value.
  console.info("[tiktok] connect →", { authorizeHost: authorizeUrl.host });

  return NextResponse.redirect(authorizeUrl, 307);
}
