# Security Policy — Mthryve OS

This is the private production platform of Mthryve Marketing Inc. It handles
multi-brand operational data for an official TikTok & Shopee partner agency.
Security is a launch-blocking concern, not a post-launch nicety.

## Reporting a vulnerability

Do **not** open a public issue for a security problem. Report it privately to
the maintainer (albertjhonmorales@gmail.com) with steps to reproduce and, if
known, the affected route/table/migration. You will get an acknowledgement and
a remediation plan. Do not test against production data you do not own.

## Secrets

- **Never commit secrets.** All credentials (Supabase service-role key,
  `ANTHROPIC_API_KEY`, TikTok/Shopee/Lazada/Zapier tokens) live only in
  Vercel/Supabase environment variables — never in code, docs, or artifacts
  (DECISIONS.md D-006).
- `.env*.local` is gitignored. `.env.example` documents variable *names* only,
  never values.
- **Automated enforcement:** every push and pull request is scanned for leaked
  secrets by [gitleaks](https://github.com/gitleaks/gitleaks) in CI
  (`.github/workflows/ci-security.yml`, config in `.gitleaks.toml`). A hit fails
  the build.
- If a secret is ever exposed, **revoke and rotate it immediately** — treat the
  old value as compromised regardless of exposure window. (See the 2026-07-07
  self-inflicted incident in CHANGELOG.md: a diagnostic endpoint printed a key;
  it was rotated within the hour. Lesson: never log or return a secret's value,
  even temporarily — presence and length only.)

## Database security model (Supabase / Postgres)

- **RLS on every table.** Row-Level Security is the primary access control.
  Policies are scoped through `org_id` via the `current_org_id()` /
  `current_user_role()` helpers. Every new table ships with an explicit,
  reviewed policy before merge (BUGS.md R-001).
- **Verified, not assumed.** RLS enforcement is proven against the live DB as a
  restricted `team_member` in `database/tests/rls_verification.sql`.
- **`SECURITY DEFINER` functions** pin `search_path = ''` and fully-qualify all
  references. The only signed-in-executable definer functions are the two RLS
  helpers, which return only the caller's own `org_id`/`role` (DECISIONS.md
  D-009); this is the sole intentional advisor warning.
- **Tamper-proof audit trail (INC-2026-002, DECISIONS.md D-011).** Privileged
  changes (approval decisions, user role changes) are recorded by a
  `SECURITY DEFINER` trigger whose actor is always `auth.uid()` — un-forgeable.
  `audit_logs` has no client write policy, so it cannot be forged, altered, or
  deleted through the API; it is readable by CEO/COO only. Proven in
  `database/tests/audit_verification.sql`.
- **Privileged writes go through server-authoritative RPCs.** Approval decisions
  use `decide_approval()` (migration 0014) — one RLS-enforced transaction — so
  the client never writes to `tasks` / `approval_requests` / `audit_logs`
  directly.

## Application

- Invite-only auth; no public sign-up. Routes are session-guarded by middleware
  and `requireProfile` / `requireRole`.
- The AI assistant is recommend-only and never writes to production data;
  every consequential AI-initiated action goes through the human approval queue
  (DECISIONS.md D-005).
- Secrets touching third-party APIs are used only in server-side route handlers,
  never in client bundles.

## Supported versions

Only the current `main` (the live deployment) is supported. Fixes land on
`main` and deploy via Vercel.
