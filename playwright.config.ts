import { defineConfig, devices } from "@playwright/test";

// Playwright config for the permanent auth regression gate (Phase 0.4).
//
// This suite exists to replace "the CEO is the test suite" with CI: it drives a
// real browser against a deployed preview (or production) and fails the run if
// the /login screen ever regresses into the 307-redirect loop that took
// production down for ~2 weeks. See e2e/auth.spec.ts and
// .github/workflows/auth-e2e.yml.
//
// The base URL is injected per-run (a Vercel preview URL in CI, or a local dev
// server). Nothing is hard-coded so the same spec runs against any deployment.
const baseURL = process.env.E2E_BASE_URL;

// Vercel Deployment Protection SSO-walls preview URLs; a headless browser cannot
// pass that wall. The Protection Bypass for Automation secret lets CI through
// WITHOUT disabling protection itself. We send it on every request. Kept to CI:
// if the secret is unset (e.g. a local run against a dev server) we send nothing.
const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const bypassHeaders: Record<string, string> = bypassSecret
  ? {
      "x-vercel-protection-bypass": bypassSecret,
      // Ask Vercel to set the bypass cookie so client-side navigations (which the
      // browser makes without our extra headers) also clear the protection wall.
      "x-vercel-set-bypass-cookie": "true",
    }
  : {};

export default defineConfig({
  testDir: "e2e",
  // The incident condition is a fresh, cookie-less browser — Playwright's default
  // per-test isolation already gives each test its own context with no shared
  // storage state, so the incognito case is the default here, not a special case.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry: a real network flake against a live deploy shouldn't red the gate,
  // but a genuine redirect loop reproduces on the retry too.
  retries: 1,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL,
    extraHTTPHeaders: bypassHeaders,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
