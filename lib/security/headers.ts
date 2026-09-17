// Security response headers + Content-Security-Policy (PASTE 2.4 — Part B).
//
// script-src intentionally does NOT use a per-request nonce + `'strict-dynamic'`.
// That combination only works if EVERY page is dynamically rendered, so Next.js
// can stamp the live per-request nonce onto its own bootstrap/hydration scripts.
// Statically prerendered pages (e.g. the `"use client"` /login page) ship
// build-time HTML whose script tags carry no such nonce — and because a CSP3
// browser ignores `'unsafe-inline'` and host allowlists the moment a nonce or
// `'strict-dynamic'` is present, every framework script was blocked and pages
// rendered but were not interactive (login, and everything else, broke).
//
// We therefore use a nonce-free script-src that modern browsers honour:
// `'self' 'unsafe-inline' 'unsafe-eval' https:`. This is a deliberate, scoped
// relaxation of scripts ONLY — every other directive (object-src 'none',
// frame-ancestors 'none', base-uri 'self', form-action 'self', a locked
// connect-src, etc.) and every static header below are unchanged. Styles keep
// `'unsafe-inline'` because Tailwind and framer-motion emit inline style
// attributes — style injection is not a script execution vector.

/**
 * Build the CSP string for a request. `connect-src` is locked to our own origin
 * plus the Supabase project (REST + realtime websocket), since every third-party
 * API call in this app is made server-side (never from the browser).
 */
export function buildContentSecurityPolicy(): string {
  const connectSrc = new Set<string>(["'self'"]);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (supabaseUrl) {
    try {
      const u = new URL(supabaseUrl);
      connectSrc.add(u.origin);
      connectSrc.add(`wss://${u.host}`);
    } catch {
      // Malformed env — omit rather than emit a broken directive.
    }
  }

  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' https:`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src ${Array.from(connectSrc).join(" ")}`,
    `media-src 'self' blob: https:`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    // Live & Video Wall embeds: the YouTube privacy-enhanced iframe player and
    // TikTok's official embed (its embed.js frames a www.tiktok.com player).
    // Only frame-src is widened — every other directive is untouched — so an
    // external <iframe> for these three hosts is allowed while all other cross-
    // origin frames stay refused. Without this the tiles rendered "This content
    // is blocked" because the default `frame-src 'self'` refused the players.
    `frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://www.tiktok.com`,
    `upgrade-insecure-requests`,
  ];

  return directives.join("; ");
}

/**
 * Static security headers applied to every response. HSTS, frame denial,
 * nosniff, referrer policy and a conservative permissions policy (microphone
 * stays enabled for same-origin — the voice capture feature needs it).
 */
export function staticSecurityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
    "X-DNS-Prefetch-Control": "off",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), browsing-topics=()",
  };
}

/** Apply CSP + static security headers to a Headers object (in place). */
export function applySecurityHeaders(headers: Headers, csp: string): void {
  headers.set("Content-Security-Policy", csp);
  for (const [key, value] of Object.entries(staticSecurityHeaders())) {
    headers.set(key, value);
  }
}
