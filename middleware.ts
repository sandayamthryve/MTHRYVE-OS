import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildContentSecurityPolicy,
  applySecurityHeaders,
} from "@/lib/security/headers";
import {
  rateLimit,
  clientIp,
  RATE_LIMITS,
  type RateCategory,
} from "@/lib/security/rate-limit";
import { isMfaEnforcementEnabled, evaluateMfaGate } from "@/lib/auth/mfa";
import { isDevChannelAuthBypassEnabled } from "@/lib/auth/dev-channel";
import { workspaceHome } from "@/lib/auth/module-access";
import { DEV_SESSION_COOKIE, DEV_ROLE_COOKIE, PREVIEW_PATH_HEADER, PREVIEW_QUERY_HEADER, resolvePreviewRole, canAccessPreviewRequest } from "@/lib/auth/preview-access";


// Optional database-independent perimeter gate. This runs before Supabase and
// can protect preview/private deployments even when the database is unavailable.
// It is deliberately opt-in and fails closed when enabled without credentials.
async function credentialDigest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function applyAppAccessGate(
  request: NextRequest,
  csp: string
): Promise<NextResponse | null> {
  if (process.env.APP_GATE_ENABLED !== "true") return null;

  const expectedUsername = process.env.APP_GATE_USERNAME;
  const expectedPassword = process.env.APP_GATE_PASSWORD;

  if (!expectedUsername || !expectedPassword) {
    const response = NextResponse.json(
      { error: "Application access gate is not configured." },
      { status: 503 }
    );
    response.headers.set("Cache-Control", "no-store");
    applySecurityHeaders(response.headers, csp);
    return response;
  }

  const authorization = request.headers.get("authorization");
  let suppliedUsername = "";
  let suppliedPassword = "";

  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        suppliedUsername = decoded.slice(0, separator);
        suppliedPassword = decoded.slice(separator + 1);
      }
    } catch {
      // Malformed credentials are handled exactly like invalid credentials.
    }
  }

  const [usernameMatches, passwordMatches] = await Promise.all([
    Promise.all([
      credentialDigest(suppliedUsername),
      credentialDigest(expectedUsername),
    ]).then(([left, right]) => equalDigest(left, right)),
    Promise.all([
      credentialDigest(suppliedPassword),
      credentialDigest(expectedPassword),
    ]).then(([left, right]) => equalDigest(left, right)),
  ]);

  if (usernameMatches && passwordMatches) return null;

  const response = NextResponse.json(
    { error: "Authentication required." },
    { status: 401 }
  );
  response.headers.set(
    "WWW-Authenticate",
    'Basic realm="Mthryve OS", charset="UTF-8"'
  );
  response.headers.set("Cache-Control", "no-store");
  applySecurityHeaders(response.headers, csp);
  return response;
}

// Classify a request path into a rate-limited category (PASTE 2.4 — Part C).
// AUTH  — interactive login/password pages + OAuth start/callback flows.
// AI    — LLM / generation / transcription / embedding endpoints (cost-sensitive).
// WEBHOOK — external provider completion callbacks.
// Everything else is unclassified and not throttled here.
function classifyPath(pathname: string): RateCategory | null {
  if (
    pathname === "/login" ||
    pathname.startsWith("/set-password") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api/security/login-failed") ||
    pathname.startsWith("/api/canva/connect") ||
    pathname.startsWith("/api/canva/callback") ||
    pathname.startsWith("/api/integrations/tiktok/connect") ||
    pathname.startsWith("/api/integrations/tiktok/callback")
  ) {
    return "auth";
  }

  if (pathname.startsWith("/api/integrations/") && pathname.endsWith("/webhook")) {
    return "webhook";
  }

  if (
    pathname.startsWith("/api/assistant") ||
    pathname.startsWith("/api/content-studio") ||
    pathname.startsWith("/api/csi") ||
    pathname.startsWith("/api/metrics/brief") ||
    pathname.startsWith("/api/vesper") ||
    pathname.startsWith("/api/voice") ||
    pathname.startsWith("/api/knowledge/ingest") ||
    // The public contributor endpoint runs a vision read on Snap-to-Data. It has
    // no session (the token is the credential), so only the per-IP AI limit
    // applies — enough to protect the vision budget from an unauthenticated caller.
    pathname.startsWith("/api/host")
  ) {
    return "ai";
  }

  return null;
}

function tooManyRequests(reset: number, csp: string): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  const res = NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429 }
  );
  res.headers.set("Retry-After", String(retryAfter));
  applySecurityHeaders(res.headers, csp);
  return res;
}

// THE redirect-loop fix. Every auth redirect is a NEW response object, so it
// does NOT inherit the cookies the Supabase server client just wrote onto the
// working `response` (a refreshed access/refresh token, or a cleared stale
// session). Without carrying those cookies over, the refreshed/invalidated auth
// state never reaches the browser, the same bad cookie is replayed on the next
// request, and the user 307-loops forever. Copy them onto the redirect so the
// Set-Cookie headers actually ship. Overwrites any same-named cookie on the
// redirect (e.g. the stale-clear below) with the working response's version.
function copyCookies(from: NextResponse, to: NextResponse): void {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
}

// On an auth error (classically "Invalid Refresh Token: refresh_token_not_found")
// the sb-* auth cookies in the request are stale/poisoned. Expire them on the
// working response so the browser drops them; otherwise the same invalid cookie
// is replayed on every subsequent request and keeps re-triggering the loop.
// Supabase may chunk the token cookie (sb-<ref>-auth-token.0/.1…), so match the
// whole sb- prefix rather than a single fixed name.
function clearStaleAuthCookies(request: NextRequest, response: NextResponse): void {
  for (const cookie of request.cookies.getAll()) {
    if (cookie.name.startsWith("sb-")) {
      response.cookies.set({ name: cookie.name, value: "", maxAge: 0, path: "/" });
    }
  }
}

// Refreshes the Supabase session on every request and redirects
// unauthenticated users away from protected routes. Role-specific
// guards (Department Head vs Team Member, etc.) land in Milestone 1
// once the roles table + lookup exist — this only checks "logged in at all".
//
// It also applies the Content-Security-Policy and rate-limits the auth/AI/webhook
// categories (PASTE 2.4 — Parts B & C). Security headers are applied to every
// response returned from here, including the 429 and redirect responses.
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CSP applied to every response below. script-src is nonce-free (see
  // lib/security/headers.ts for why the nonce + strict-dynamic approach was
  // dropped), so there is no per-request token to propagate onto the request.
  const csp = buildContentSecurityPolicy();

  const accessGateResponse = await applyAppAccessGate(request, csp);
  if (accessGateResponse) return accessGateResponse;

  // Devchannel mock mode skips Supabase auth and uses a lightweight demo-session
  // cookie behind the real perimeter password. No database login is involved.
  if (isDevChannelAuthBypassEnabled()) {
    // Keep redirects on the browser-facing host; Next can normalize loopback
    // hosts internally, which otherwise drops the operator cookie on redirect.
    const demoUrl = (path: string) => {
      const url = new URL(path, request.url);
      url.host = request.headers.get("host") ?? url.host;
      return url;
    };
    const hasDemoSession = request.cookies.get(DEV_SESSION_COOKIE)?.value === "active";
    const role = resolvePreviewRole(request.cookies.get(DEV_ROLE_COOKIE)?.value);
    const isDemoLogin = pathname === "/login";
    const isApi = pathname.startsWith("/api/");
    const isStatic = /^\/tony\/(orbit\.(js|css)|planet-preview\.(js|css|html)|three-r128\.min\.js)$/.test(pathname);
    const finish = (response: NextResponse) => {
      response.headers.set("Cache-Control", "private, no-store");
      applySecurityHeaders(response.headers, csp);
      return response;
    };
    if (isDemoLogin && hasDemoSession && role) {
      return finish(NextResponse.redirect(demoUrl(workspaceHome(role))));
    }
    if (!hasDemoSession && !isDemoLogin && !isStatic) {
      if (isApi) return finish(NextResponse.json({ error: "Authentication required." }, { status: 401 }));
      const loginUrl = demoUrl("/login");
      loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
      return finish(NextResponse.redirect(loginUrl));
    }
    // Send a role to its home, but only when that home is somewhere else.
    // workspaceHome() now returns "/" for every role, so the old unconditional
    // redirect turned a non-operator GET "/" into "/" -> "/" -> "/": an
    // infinite 307 loop that left the dashboard unreachable for every preview
    // role. Comparing first keeps "/home" -> "/" working and restores the
    // redirect automatically if workspaceHome ever points off "/" again.
    if (role && role !== "operator" && ["/", "/home"].includes(pathname)) {
      const home = workspaceHome(role);
      if (home !== pathname && (request.method === "GET" || request.method === "HEAD")) {
        return finish(NextResponse.redirect(demoUrl(home)));
      }
    }
    const roleControl = pathname === "/api/dev/role";
    if (!isDemoLogin && !isStatic && !roleControl &&
        !canAccessPreviewRequest(role, pathname, request.nextUrl.search)) {
      if (isApi || !["GET", "HEAD"].includes(request.method)) {
        return finish(NextResponse.json({ error: "This module is not available to the selected role." }, { status: 403 }));
      }
      if (!role) {
        const response = NextResponse.redirect(demoUrl("/login"));
        response.cookies.delete(DEV_SESSION_COOKIE);
        response.cookies.delete(DEV_ROLE_COOKIE);
        return finish(response);
      }
      return finish(NextResponse.redirect(demoUrl("/access-denied")));
    }
    const requestHeaders = new Headers(request.headers);
    // Never trust a client-supplied pathname or department scope.
    requestHeaders.set(PREVIEW_PATH_HEADER, pathname);
    requestHeaders.set(PREVIEW_QUERY_HEADER, request.nextUrl.search);
    return finish(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const category = classifyPath(pathname);

  // POST-ONLY throttling. A page load — GET /login, a prefetch, a static asset,
  // an OAuth callback redirect — must NEVER be rate-limited: only the actual
  // credential submit / write (the login POST, an AI generation POST, a webhook
  // POST) consumes a token. This is the fix for the lockout: hammering GET
  // /login can no longer 429 the page out from under every visitor. (Static and
  // _next are already excluded by the matcher below; this is the belt to that
  // suspenders — and it also spares OAuth GET callbacks and prefetches.)
  const isThrottleable = category !== null && request.method === "POST";

  // Per-IP throttle for every rate-limited category (auth/AI/webhook). The
  // limiter fails open on any store error and honors the RATE_LIMIT_DISABLED
  // kill-switch internally, so this can never 429 on infra failure.
  if (isThrottleable) {
    const ip = clientIp(request);
    const ipResult = await rateLimit(`${category}:ip:${ip}`, RATE_LIMITS[category].ip);
    if (!ipResult.success) return tooManyRequests(ipResult.reset, csp);
  }

  // ONE response object. The Supabase server client writes refreshed/cleared
  // auth cookies onto it via setAll (below), and every redirect copies those
  // cookies over (see copyCookies) so they actually reach the browser. Kept as
  // `let` because setAll rebuilds it to keep the request cookies in sync for
  // getUser().
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          // Mirror onto the request so a getUser() token refresh in this same
          // pass reads the fresh cookie, then re-derive the response and write
          // the Set-Cookie headers onto it (the @supabase/ssr 0.5+ contract).
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { data, error } = await supabase.auth.getUser();

  // Invalid/expired refresh token → the sb-* cookies are poisoned. Clear them on
  // the working response so the bad cookie can't replay and re-open the loop.
  // Copied onto every redirect below via copyCookies. No user is present on an
  // error, so this only ever clears — it never touches a live session.
  if (error) {
    clearStaleAuthCookies(request, response);
  }

  // Per-user throttle for AI endpoints (in addition to the per-IP limit above),
  // so a single signed-in account can't exhaust the AI budget from many IPs.
  // POST-only, same as the per-IP throttle — a GET must never be limited.
  if (isThrottleable && category === "ai" && data.user) {
    const userResult = await rateLimit(`ai:user:${data.user.id}`, RATE_LIMITS.ai.user);
    if (!userResult.success) return tooManyRequests(userResult.reset, csp);
  }

  // The plain login page (exact) vs the MFA step-up challenge (/login/mfa). They
  // share the /login prefix but behave oppositely: an already-signed-in visitor
  // is bounced OFF the login page, but the challenge page is exactly where an
  // aal1 user is SUPPOSED to be — so it must not be treated as the login page.
  const isLoginPage = pathname === "/login";
  // /auth/* handlers (invite, magic link, recovery callbacks) must run even
  // for a not-yet-authenticated visitor — that's exactly where the session
  // gets established. Blocking them was why every email link bounced to /login.
  // /set-password is where invite/recovery users land immediately after the
  // callback verifies their token; it must never redirect to /login mid-flow,
  // before the session cookie has fully propagated.
  // The Layer-5 automation gateway (/api/automation/*) is called by n8n with only
  // a Bearer secret and no Supabase session cookie. It enforces its own auth
  // (AUTOMATION_API_KEY) inside the route handler, so it must be exempt from the
  // session-redirect here — otherwise every n8n POST would 307 to /login and
  // never reach the handler. Agent CSI's research endpoint (/api/csi/*) accepts
  // the SAME bearer for the n8n path (plus an OS session for the /csi UI) and
  // likewise authenticates inside the handler, so it is exempt for the same
  // reason — a cookie-less bearer call must reach the route, not bounce to /login.
  // /api/security/* self-authenticates inside its handlers: the anomaly-scan cron
  // uses a Bearer secret (or a leader session), and login-failed is a public
  // fire-and-forget signal hit by an unauthenticated visitor. Like the automation
  // and CSI gateways, a cookie-less call must reach the handler, not bounce to
  // /login.
  // The integrations gateway (/api/integrations/*) is the same shape: the TikTok
  // Shop daily READ-sync (/api/integrations/tiktok/sync) and reconcile are called
  // by n8n / Vercel Cron with only a machine Bearer (AUTOMATION_API_KEY or
  // CRON_SECRET) and no Supabase session cookie, so a session redirect here would
  // 307 them to /login and the route would never run. Every route under this
  // prefix already enforces its OWN auth inside the handler — the sync/reconcile
  // endpoints check the machine bearer (or a leadership session), the diag/status/
  // connect/callback routes call requireRole/requireProfile (which self-redirect),
  // and the provider webhooks verify a signature — so exempting the prefix from the
  // middleware redirect opens nothing; it just lets the cookie-less bearer call
  // reach the handler. Mirrors the /api/automation exemption exactly.
  // The contributor token surface (/host/<token>) and its write endpoint
  // (/api/host/<token>) are PUBLIC by design: a live host / intern has no OS
  // login and acts entirely through the unguessable token in their link. Both
  // re-validate the token server-side on every request (the token IS the
  // credential), so they must reach the handler rather than bounce to /login.
  const isPublicRoute =
    isLoginPage ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/set-password") ||
    pathname === "/host" ||
    pathname.startsWith("/host/") ||
    pathname.startsWith("/api/host") ||
    pathname.startsWith("/api/automation") ||
    pathname.startsWith("/api/integrations") ||
    pathname.startsWith("/api/security") ||
    pathname.startsWith("/api/csi");

  if (!data.user && !isPublicRoute) {
    const redirect = NextResponse.redirect(new URL("/login", request.url));
    copyCookies(response, redirect);
    applySecurityHeaders(redirect.headers, csp);
    return redirect;
  }

  if (data.user && isLoginPage) {
    // Send an already-signed-in visitor to the role dispatcher, which routes each
    // role to their own home cockpit. (The MFA challenge page is intentionally
    // NOT the login page, so an aal1 user there is left alone.)
    const redirect = NextResponse.redirect(new URL("/home", request.url));
    copyCookies(response, redirect);
    applySecurityHeaders(redirect.headers, csp);
    return redirect;
  }

  // ── MFA step-up gate (PASTE B) ───────────────────────────────────────────────
  // OFF by default: does nothing unless MFA_ENFORCEMENT_ENABLED === "true". When
  // on, an authenticated user on a private route who hasn't reached aal2 is sent
  // to the TOTP challenge (if they have a verified factor) or to enrollment (if
  // their role requires MFA) — NEVER a wall (see lib/auth/mfa.ts). Exemptions:
  //   • public / machine routes (isPublicRoute) — no session to step up;
  //   • /api/auth/* — the auth + MFA reporting endpoints self-verify the session
  //     and must reach their handler rather than 307 to an HTML challenge page.
  // The challenge page itself (/login/mfa) is non-public and IS evaluated, but
  // evaluateMfaGate returns null for it, so it's reachable. Fails open on any
  // read error — a transient blip must not lock the org out.
  if (
    isMfaEnforcementEnabled() &&
    data.user &&
    !isPublicRoute &&
    !pathname.startsWith("/api/auth")
  ) {
    const target = await evaluateMfaGate(supabase, data.user.id, pathname);
    if (target && target !== pathname) {
      const redirect = NextResponse.redirect(new URL(target, request.url));
      copyCookies(response, redirect);
      applySecurityHeaders(redirect.headers, csp);
      return redirect;
    }
  }

  applySecurityHeaders(response.headers, csp);
  return response;
}

export const config = {
  // /privacy and /terms are public, no-auth legal pages — they are excluded
  // here so the middleware (and its Supabase session lookup / login redirect)
  // never runs for them and they render for logged-out visitors.
  //
  // The PWA shell assets are also excluded: the browser fetches the manifest,
  // service worker, offline shell and app icons without necessarily carrying
  // the session cookie (and the install/lock-screen contexts have none), so a
  // login redirect would break installability and the offline fallback. These
  // files are static and non-sensitive, so exempting them is safe.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|privacy|terms|manifest.webmanifest|sw.js|offline.html|apple-touch-icon.png|icons/).*)",
  ],
};
