// Edge-compatible rate limiter (PASTE 2.4 — Part C).
//
// Distributed + durable when Upstash Redis is configured (set
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in the environment); this is
// the production path and gives exact per-IP / per-user limits across every edge
// region. When those vars are absent (local dev, first-run) it falls back to an
// in-memory fixed-window counter that is per-isolate — approximate, but keeps the
// throttle meaningful without external infra. Both paths are edge-runtime safe
// (no Node built-ins), so this module can be imported from middleware.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix ms at which the current window resets. */
  reset: number;
}

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

const hasUpstash =
  !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * Kill-switch. When `RATE_LIMIT_DISABLED === "true"` the limiter is bypassed
 * entirely — every call to {@link rateLimit} returns success. This is an
 * instant, redeploy-free recovery lever: flip the env var and the throttle is
 * neutralized on the next request (no code change, no build). Read at call time
 * (not module-load) so an env change takes effect without a cold start.
 */
export function isRateLimitDisabled(): boolean {
  return process.env.RATE_LIMIT_DISABLED === "true";
}

/** An "allowed" result, used by the kill-switch and the fail-open path. */
function allow(limit: number, windowMs: number): RateLimitResult {
  return { success: true, limit, remaining: limit, reset: Date.now() + windowMs };
}

let redis: Redis | null = null;
const upstashLimiters = new Map<string, Ratelimit>();

function getUpstashLimiter(limit: number, windowMs: number): Ratelimit {
  const windowSeconds = Math.max(1, Math.round(windowMs / 1000));
  const cacheKey = `${limit}:${windowSeconds}`;
  let limiter = upstashLimiters.get(cacheKey);
  if (!limiter) {
    if (!redis) redis = Redis.fromEnv();
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowSeconds} s`),
      prefix: "mthryve:rl",
      analytics: false,
    });
    upstashLimiters.set(cacheKey, limiter);
  }
  return limiter;
}

// --- In-memory fallback -----------------------------------------------------
// Persisted on globalThis so the map survives module re-evaluation within the
// same isolate. Fixed-window: cheap and good enough as a fallback.
type Bucket = { count: number; reset: number };
const memoryStore: Map<string, Bucket> =
  (globalThis as { __mthryveRateStore?: Map<string, Bucket> }).__mthryveRateStore ??
  new Map<string, Bucket>();
(globalThis as { __mthryveRateStore?: Map<string, Bucket> }).__mthryveRateStore =
  memoryStore;

function memoryLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  let bucket = memoryStore.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + windowMs };
    memoryStore.set(key, bucket);
  }
  bucket.count += 1;

  // Opportunistic cleanup so the map can't grow without bound in a long-lived
  // isolate. Cheap: only runs occasionally.
  if (memoryStore.size > 5000) {
    for (const [k, b] of memoryStore) {
      if (b.reset <= now) memoryStore.delete(k);
    }
  }

  const remaining = Math.max(0, limit - bucket.count);
  return { success: bucket.count <= limit, limit, remaining, reset: bucket.reset };
}

/**
 * Consume one token for `key`. Returns whether the caller is under the limit.
 *
 * FAIL-OPEN by contract: this function never throws and never denies a request
 * because of a limiter problem. If the store (Upstash Redis, or the in-memory
 * fallback) errors, is unreachable, or throws, the request is ALLOWED — a
 * limiter outage must never become an auth outage that 429s real users off the
 * login page. The only way this returns `success: false` is an explicit,
 * successful "you are over the limit" answer from the store.
 */
export async function rateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions
): Promise<RateLimitResult> {
  // Kill-switch wins over everything: no store touched, always allowed.
  if (isRateLimitDisabled()) return allow(limit, windowMs);

  try {
    if (hasUpstash) {
      const limiter = getUpstashLimiter(limit, windowMs);
      const res = await limiter.limit(key);
      return {
        success: res.success,
        limit: res.limit,
        remaining: res.remaining,
        reset: res.reset,
      };
    }
    return memoryLimit(key, limit, windowMs);
  } catch {
    // Store unreachable / threw (Upstash outage, network blip, in-memory error).
    // Fail open — allow the request rather than lock everyone out.
    return allow(limit, windowMs);
  }
}

/**
 * Best-effort client IP for the per-IP bucket key.
 *
 * Order matters: on Vercel `request.ip` is the true client address the edge
 * already resolved, so we trust it first. Otherwise we take the FIRST hop of
 * `x-forwarded-for` — the original client — never the last hop, which is the
 * shared edge/proxy address that would bucket every visitor into one counter
 * and 429 the whole org at once. `x-real-ip` / `cf-connecting-ip` are final
 * fallbacks. Returns "unknown" only when no signal is present.
 */
export function clientIp(request: Request & { ip?: string | null }): string {
  const direct = request.ip?.trim();
  if (direct) return direct;

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown"
  );
}

// Category limits. Windows are short so a burst is throttled quickly while
// normal use is never affected. Auth is the tightest (credential stuffing /
// OAuth abuse); AI is cost-sensitive; webhooks are chatty but idempotent.
//
// Auth is POST-only (see middleware): only the login credential submit counts,
// never a page load. 25 submits / 10 min per IP is generous for any real human
// (fat-finger a password a dozen times and you're still fine) while still
// blunting automated credential-stuffing. The old 20/60s was far too tight for
// a shared-IP office and is what produced the lockout.
export const RATE_LIMITS = {
  auth: { ip: { limit: 25, windowMs: 600_000 } },
  ai: {
    ip: { limit: 60, windowMs: 60_000 },
    user: { limit: 30, windowMs: 60_000 },
  },
  webhook: { ip: { limit: 120, windowMs: 60_000 } },
} as const;

export type RateCategory = keyof typeof RATE_LIMITS;
