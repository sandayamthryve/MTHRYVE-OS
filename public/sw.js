/*
 * Mthryve OS service worker — lightweight, privacy-safe.
 *
 * Goals:
 *  1. Make the app installable (a registered SW + manifest is the install gate).
 *  2. Offline app-shell fallback: when a navigation fails offline, show a simple
 *     "You're offline" page instead of the browser's dinosaur.
 *  3. Speed up repeat loads by caching Next's immutable build assets.
 *
 * Privacy rule (non-negotiable): this SW NEVER caches authenticated responses.
 *  - Page navigations are always network-first and their HTML is never stored
 *    (every page here is behind auth and renders user-scoped data).
 *  - API routes, Supabase calls and any non-GET request bypass the cache
 *    entirely and go straight to the network.
 * Only static, non-sensitive build assets and the static offline shell are
 * cached.
 */

const VERSION = "v1";
const STATIC_CACHE = `mthryve-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";

// The static app shell precached on install — all non-sensitive.
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("mthryve-") && key !== STATIC_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Is this a same-origin, cacheable static build asset? Next emits immutable,
// content-hashed files under /_next/static — safe to cache long-term. Our own
// /icons/* live in the precache. We deliberately exclude everything else.
function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/"))
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever touch GET; POST/PUT/etc (mutations, sign-in) go straight through.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Navigations: network-first, fall back to the offline shell. The live HTML
  // response is never stored (it is user-scoped, authenticated content).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL, { ignoreSearch: true }).then(
          (cached) =>
            cached ||
            new Response("You are offline.", {
              status: 503,
              headers: { "Content-Type": "text/plain" },
            })
        )
      )
    );
    return;
  }

  // Immutable build assets: stale-while-revalidate for instant repeat loads.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Everything else (API routes, Supabase, third-party): straight to network,
  // never cached — this is where authenticated data lives.
});
