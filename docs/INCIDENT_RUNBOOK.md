# Mthryve OS — Security Incident Runbook

This runbook is linked from every anomaly alert (Telegram + the
`security_anomalies` board). It tells the on-call leader (CEO/COO) what each
alert means and the first three moves. It is deliberately short and action-first.

> Governing rule: **contain first, then diagnose.** No alert is "probably
> nothing" until you've looked. All timestamps are the app's timezone (Asia/Manila).

## Where the signals live

| Table | What it holds | Who can read |
|---|---|---|
| `ai_usage_log` | one row per AI call (agent, model, tokens, ₱ estimate) | ceo / coo |
| `security_events` | failed logins, RLS denials, data exports, mass reads, injection flags, output redactions | ceo / coo |
| `security_anomalies` | raised alerts (kind, metric, threshold, window, status) | ceo / coo |

The monitor runs hourly (`/api/security/anomaly-scan`, Vercel Cron) and on demand
(a leader can POST the same route). It compares the last 60 min against a rolling
7-day baseline and raises one alert per `org + kind + window`.

## Alert types & first moves

### `spend_spike` — AI spend spike
1. Open `ai_usage_log` for the window; sort by `est_cost_php`. Identify the
   agent + user driving it.
2. If a single account/loop is runaway: revoke its session, and (temporarily)
   lower that role's model tier / pause the offending automation.
3. Confirm the money-gate held — no `spend`/`outbound` action executed without an
   approval (`action_audit` events `policy_needs_approval` / `executed`).

### `mass_data_reads` — abnormal read volume
1. `ai_usage_log` for the window → `top_user` in the alert detail. Is it a human
   or an automation? Legitimate bulk work, or scraping?
2. If suspicious: revoke the session; confirm RLS scoped every read (a team
   member cannot read another org / leadership-only tables regardless of volume).

### `failed_login_burst` — credential stuffing / brute force
1. `security_events` where `event_type='failed_login'` in the window → group by
   `subject` (email) and `ip`.
2. Single account targeted → notify that user, force a password reset. Many
   accounts from few IPs → treat as an attack; the middleware `auth` rate-limit
   should already be throttling — verify it is, tighten `RATE_LIMITS.auth` if not.

### `rls_denial_surge` — permission probing / misconfig
1. `security_events` where `event_type='rls_denial'` → which tool/table, which
   user. A surge from one user = probing; a surge across users = a broken policy.
2. If probing: revoke the session. If a policy regression: roll back the offending
   migration and re-run `database/tests/rls_verification.sql`.

### `unusual_export_volume` — potential data exfiltration
1. `security_events` where `event_type='data_export'` → who, what, how many rows.
2. Confirm the exporter had the role to see that data. If not (should be
   impossible under RLS), treat as an incident: revoke, rotate, and review.

## Escalation & records

- **Contain** (revoke/pause) before deep analysis on any `critical` alert.
- **Rotate** any secret you even suspect was exposed — treat presence as
  compromise (see `SECURITY.md`, the 2026-07-07 lesson).
- **Record** the incident and its resolution; mark the `security_anomalies` row
  `acknowledged` then `resolved` with a note. Log a `DECISIONS.md` entry if a
  threshold or policy changed as a result.

## Tuning the monitor (leadership, no deploy needed)

Thresholds are environment variables (Vercel): `ANOMALY_WINDOW_MINUTES`,
`ANOMALY_BASELINE_DAYS`, `ANOMALY_SPIKE_FACTOR`, `ANOMALY_SPEND_FLOOR_PHP`,
`ANOMALY_MASS_READ_FLOOR`, `ANOMALY_FAILED_LOGIN_FLOOR`,
`ANOMALY_RLS_DENIAL_FLOOR`, `ANOMALY_EXPORT_FLOOR`. Per-tool kill-switches live in
`policy_registry` (category `tool_permission`, `rule.deny_tools`).

## The auth regression gate (Phase 0.4)

Production `/login` 307-redirect-looped for ~2 weeks. Root cause: the Supabase
SSR middleware dropped cookies on redirect responses (fixed in PR #214 /
`a66dee3`). The deeper root cause was process: **auto-promote is ON and there
was ZERO automated verification between a merge and the team's login screen —
the CEO was the test suite.** Two things now stand in for him. Neither modifies
auth logic; both are additive verification.

### 1. `auth-e2e` — the pre-merge gate (CI)

- `.github/workflows/auth-e2e.yml` fires on `deployment_status` (Vercel's
  GitHub deployment reaches `success` with the preview URL ready — no polling).
  It runs `e2e/auth.spec.ts` in a real, cookie-less Chromium against the preview.
- The spec asserts, in a **fresh (incognito) context** — the exact incident
  condition: cookie-less `/login` returns **200, not 307, not 429**, with the
  form rendered; a real login lands off `/login`; the session **persists across a
  reload** (the assertion that catches the cookie-propagation bug); logout returns
  cleanly. The **loop detector** counts 3xx hops per path and fails on the
  `/login 307 → /home 307 → /login 307 …` signature — a plain "page loaded" test
  passes while a 2-hop loop is silently forming, so we assert the redirect COUNT.
- It runs as the **dedicated test user** (`E2E_USER_EMAIL` / `E2E_USER_PASSWORD`
  secrets) — a normal RLS-scoped `team_member`, **not a real employee account,
  never ceo/coo, never a service key**. Do not delete this Supabase user; the
  gate goes red without it.
- Preview URLs are SSO-walled by Vercel Deployment Protection. CI passes the wall
  with the **Protection Bypass for Automation** secret
  (`VERCEL_AUTOMATION_BYPASS_SECRET`), sent as request headers — protection itself
  stays ON.
- **This is only a gate if `auth-e2e` is a REQUIRED status check on `main`**
  (Settings → Branches). Without that, a red run does not block merge.

### 2. `/api/monitor/auth-health` — the production heartbeat (Cron)

- Auto-promote stays ON, so production needs verification independent of CI.
  A scheduled GitHub Actions heartbeat (`.github/workflows/auth-heartbeat.yml`,
  every ~10 min) hits the route with `Authorization: Bearer ${CRON_SECRET}` (not
  publicly triggerable). The schedule lives in GitHub Actions rather than
  `vercel.json` because `*/5` Vercel Cron is Pro-only and Hobby rejects the whole
  deployment at parse time. GitHub scheduled runs are best-effort (can drift
  5–15 min). The route fetches the live `/login` **without following redirects**:
  healthy = `200` + the sign-in marker; unhealthy = any 3xx / any 429 / non-200 /
  missing marker. A red run in the Actions tab is itself an alert.
- Each result is written to `system_health_checks` (org-scoped, leadership-read).
  A transition **into** unhealthy fires a `critical` leadership notification
  (`auth_health_alert`) — a failed check is never silently swallowed.

### NEVER-PROMOTE doctrine

- **`ac771d9` (#210) is NEVER-PROMOTE.** Vercel logs from 2026-07-27 10:08 UTC
  prove #210 carries the same `/login ↔ /home` redirect loop; the old rate
  limiter merely masked it until a session went stale. **Every production deploy
  from #206 through #213 carries the same latent bug.**
- The first genuinely safe production commit is **`a66dee3` (PR #214)**.
- **Emergency rollback target = the last deploy that PASSED `auth-e2e`**, never
  "the one before the change." A deploy that predates the gate has not been
  verified and is not a safe rollback target by default.
