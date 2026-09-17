import { test, expect, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Permanent auth regression gate (Phase 0.4).
//
// WHY THIS EXISTS: production /login 307-redirect-looped for ~2 weeks because the
// Supabase SSR middleware dropped cookies on redirect responses. Auto-promote is
// ON and there was ZERO automated verification between a merge and the team's
// login screen — the CEO was the test suite. This spec is the replacement.
//
// Every test runs in a FRESH browser context (Playwright's default per-test
// isolation — no shared storageState). The cookie-less/incognito condition is the
// exact one that took production down, so it is the DEFAULT here, not a special
// case.
//
// The most important thing in this file is the LOOP DETECTOR. A plain "did the
// page load" assertion passes while a 2-hop 307 loop is silently forming. We
// assert the redirect COUNT per path, not just the final state.
// ─────────────────────────────────────────────────────────────────────────────

const REDIRECT_CODES = [301, 302, 307, 308];
// A redirect chain of >2 hops on the same path is the loop signature from the
// Vercel logs (/login 307 → /home 307 → /login 307 …). Two hops is the most a
// healthy auth flow needs (e.g. /login → /home → /).
const MAX_REDIRECTS_PER_PATH = 2;

interface AuthProbe {
  /** Redirect hits observed per URL pathname for the life of the page. */
  redirectHits: Map<string, number>;
  /** Any 429 seen on a GET request to /login — an instant, unconditional fail. */
  rateLimitedLoginGets: string[];
}

// Attach network listeners that watch for the two production failure signatures:
//   1. a redirect LOOP (many 3xx hops repeating on the same path), and
//   2. a 429 on GET /login (the old rate limiter masking the loop until a
//      session went stale — see doctrine: #206–#213 all carry this latent bug).
function installAuthProbe(page: Page): AuthProbe {
  const probe: AuthProbe = { redirectHits: new Map(), rateLimitedLoginGets: [] };

  page.on("response", (r) => {
    const status = r.status();
    let pathname: string;
    try {
      pathname = new URL(r.url()).pathname;
    } catch {
      return;
    }

    if (REDIRECT_CODES.includes(status)) {
      probe.redirectHits.set(pathname, (probe.redirectHits.get(pathname) ?? 0) + 1);
    }

    // Fail the run on ANY 429 observed on a GET to /login.
    if (status === 429 && r.request().method() === "GET" && pathname === "/login") {
      probe.rateLimitedLoginGets.push(`${status} GET ${pathname} (${r.url()})`);
    }
  });

  return probe;
}

// Assert both failure signatures are absent. Call after every navigation.
function assertNoLoops(probe: AuthProbe) {
  for (const [path, n] of probe.redirectHits) {
    expect(n, `redirect loop on ${path} (${n} redirects; loop signature is >2)`).toBeLessThanOrEqual(
      MAX_REDIRECTS_PER_PATH
    );
  }
  expect(
    probe.rateLimitedLoginGets,
    `429 on GET /login — the rate limiter must never gate the login screen:\n${probe.rateLimitedLoginGets.join(
      "\n"
    )}`
  ).toHaveLength(0);
}

function requireCreds(): { email: string; password: string } {
  const email = process.env.E2E_USER_EMAIL;
  const password = process.env.E2E_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "E2E_USER_EMAIL / E2E_USER_PASSWORD must be set (dedicated Supabase test user — see PR description)."
    );
  }
  return { email, password };
}

// Sign in with the dedicated test user and wait for the dashboard to settle off
// of /login. Shared by the login, persistence and logout tests.
async function signIn(page: Page) {
  const { email, password } = requireCreds();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // The form pushes to /home which dispatches to the role home ("/"). Wait for
  // the authenticated shell rather than a specific URL so this survives role
  // routing changes.
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible({ timeout: 15_000 });
}

test.describe("auth regression gate", () => {
  // (a) Cookie-less /login renders — the exact incident condition.
  // @gate: the BLOCKING assertion. Runs in the required `auth-e2e` job; it is the
  // one that reproduces the production redirect-loop failure and must stay green
  // on clean code.
  test("cookie-less /login renders with 200 (not 307, not 429)", { tag: "@gate" }, async ({ page }) => {
    const probe = installAuthProbe(page);

    const response = await page.goto("/login");
    expect(response, "no response for /login").not.toBeNull();

    const status = response!.status();
    // The final response must be a clean 200 — explicitly NOT the loop's 307 and
    // NOT the rate limiter's 429.
    expect(status, `final /login status was ${status}`).toBe(200);
    expect(status).not.toBe(307);
    expect(status).not.toBe(429);

    // The sign-in form must actually be there — email, password, and the button.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    assertNoLoops(probe);
  });

  // (b) A real login lands on the dashboard, not back on /login.
  // @full: the real logged-in flow. Runs in the `auth-e2e-full` job with the
  // dedicated e2e-bot credentials against the preview. UN-QUARANTINED now that
  // the /login ⇄ /home 307 loop is fixed — a real sign-in completes and lands on
  // the dashboard, so this blocks like the @gate test.
  test("real login lands on the dashboard", { tag: "@full" }, async ({ page }) => {
    const probe = installAuthProbe(page);

    await signIn(page);

    expect(new URL(page.url()).pathname, "still on /login after sign-in").not.toBe("/login");
    // A known authenticated element (the app shell's Sign out control).
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();

    assertNoLoops(probe);
  });

  // (c) The session persists across a reload — THIS is the assertion that would
  // have caught the original cookie-propagation bug.
  test("session persists across reload", { tag: "@full" }, async ({ page }) => {
    const probe = installAuthProbe(page);

    await signIn(page);
    await page.reload();

    expect(new URL(page.url()).pathname, "reload bounced us to /login").not.toBe("/login");
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();

    assertNoLoops(probe);
  });

  // (d) Logout returns cleanly to a rendered /login — no loop.
  test("logout returns cleanly to /login", { tag: "@full" }, async ({ page }) => {
    const probe = installAuthProbe(page);

    await signIn(page);
    await page.getByRole("button", { name: /sign out/i }).click();

    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname, "sign-out did not land on /login").toBe("/login");
    // Form must render, not just the URL.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();

    assertNoLoops(probe);
  });
});
