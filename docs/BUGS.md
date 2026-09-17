# Mthryve OS — BUGS.md

Risk register + known issues. The MVP is now deployed, so several design-stage risks have been mitigated or verified against the live system (see Status lines and the Resolved section).

---

## Open Risks (pre-launch)

### R-001: Multi-tenant data isolation
**Risk:** RLS policies are the only thing preventing cross-org data leakage once a second tenant exists. A single missing or misconfigured policy is a real data breach, not a cosmetic bug.
**Mitigation:** Write RLS policy tests as part of Milestone 0, before any feature ships. Every new table needs an explicit RLS policy reviewed against `org_id`/`tenant_id` scoping before merge.
**Status:** Mitigated (M8) — every table has org-scoped RLS, and it's now **verified against the live DB** as a restricted `team_member`: audit-log hidden, cross-user AI messages isolated, approve/metrics writes rejected (42501). See `database/tests/rls_verification.sql`. Re-run this suite whenever a table is added.

### R-002: MLM / DTI-SEC-FDA compliance on Distributor module
**Risk:** Carried over directly from the existing Distributor Network Dashboard artifact — four of five compliance checks passed, but the 80%+ real-product-sales-revenue check remains conditional pending live transaction data. If this module goes live in Path B before that data is validated, the platform could be operating on an unverified compliance assumption.
**Mitigation:** Do not activate the production Distributor Portal (V3 milestone) until the 80%+ check is confirmed against real Shopify/Zapier transaction data, not projected figures.
**Status:** Open — tracked, blocking V3 distributor module activation, not MVP.

### R-003: Real API key handling during migration
**Risk:** As integrations (TikTok/Shopee/Lazada/Zapier) move from "identified as the bridge" to "actually connected," real credentials enter the system for the first time. A single mistake (key in a commit, key in a client-side bundle) is a real exposure.
**Mitigation:** Enforce D-006 (`DECISIONS.md`) — env vars only, server-side routes only for anything touching a secret. Add a pre-commit check or CI step that scans for likely key patterns before this becomes urgent.
**Status:** Resolved (Sprint 0) — the guardrail now exists: gitleaks scans every push/PR in CI (`.github/workflows/ci-security.yml`, `.gitleaks.toml`), `SECURITY.md` documents secret handling, and `.env*.local` stays gitignored (D-006). Re-verify the scan stays green when real integration credentials are introduced (V2).

### R-004: AI assistant cost/runaway usage
**Risk:** A company-wide chat assistant with no rate limiting can generate unexpectedly large Claude API bills, especially once task generation and report generation (V1.5) are added.
**Mitigation:** Rate limiting and basic cost monitoring are explicitly in Milestone 5 of `TODO.md` — don't ship the assistant without them, even for MVP.
**Status:** Open — planned, not yet built.

### R-005: Auth/RBAC complexity underestimated
**Risk:** The role model (CEO, COO, Department Head, Team Member) looks simple but real org structures have exceptions (someone leads two departments, a BD lead also touches E-Commerce Ops per the existing structure). A too-rigid role model will need painful migration later.
**Mitigation:** Model permissions as a `roles.permissions jsonb` field rather than hardcoded enum checks, so exceptions are data changes, not code changes. Already reflected in the `PROJECT.md` schema.
**Status:** Partially addressed (M8) — role-gated writes are enforced by RLS (approvals/metrics decide = ceo/coo/dept-head; deletes = creator-or-admin, migration 0010). The `roles.permissions jsonb` flexible model is still deferred; current role enum is sufficient for MVP. Revisit when a real org exception appears.

### R-006: Knowledge base text extraction quality varies by file type
**Risk:** PDF/Word/PPTX extraction quality is inconsistent (scanned PDFs, complex PPTX layouts) and a poor extraction silently degrades AI search quality without an obvious error.
**Mitigation:** Log extraction confidence/method per document; surface "extraction may be incomplete" in the UI for scanned/image-heavy uploads rather than failing silently.
**Status:** Open — flagged for Milestone 4 implementation.

### R-007: Artifact-to-production migration drift
**Risk:** While Path A artifacts keep evolving during daily use (per D-001), the production schema could silently diverge from what the artifacts actually need, causing rework when each module migrates.
**Mitigation:** Before migrating any module (Affiliate/Supplier/Distributor per V3), do a fresh audit of that artifact's current `window.storage` schema and reconcile against the Postgres schema in `PROJECT.md` — don't assume the original design doc is still accurate.
**Status:** Open — process note, applies at each V3 migration point. (Separately: the repo↔live migration drift is a **recurring** failure mode — migrations 0005–0010 (M3–M7) and again 0011–0014 (Sprint 0) were applied to the live DB but not committed; both have since been reconciled so `database/migrations/` matches the live schema exactly. Root cause of the Sprint 0 recurrence: a prior session reported a commit/push that never landed. **Guard:** after any migration work, verify the branch on GitHub — don't trust a session's "pushed" claim; the live `supabase_migrations` ledger is the recovery source of truth.)

### R-008: Next.js 14.2.5 has a known security vulnerability
**Risk:** The Vercel build warns that `next@14.2.5` has a security vulnerability (see https://nextjs.org/blog/security-update-2025-12-11) and should be upgraded to a patched release. Shipping on a flagged version is an avoidable exposure.
**Mitigation:** Bump `next` to the latest patched 14.x (or plan the 15.x upgrade) and redeploy; re-run the build to confirm the warning clears.
**Status:** Resolved (M8) — pin set to `^14.2.6`. Note: `^14.2.5` alone did *not* upgrade because Vercel restores the node_modules build cache and the cached `14.2.5` already satisfied that range; a floor `14.2.5` no longer satisfies (`^14.2.6`) forces npm to re-resolve to the latest patched 14.2.x. Verify `Detected Next.js version` on the build log shows > 14.2.5.

### R-010: Supabase leaked-password protection disabled
**Risk:** Supabase advisor flags that Auth doesn't check new passwords against HaveIBeenPwned, so users can set known-compromised passwords.
**Mitigation:** **[USER]** Enable it in the Supabase dashboard → Authentication → Providers → Password → "Check against HaveIBeenPwned". Not togglable via the connector/SQL — dashboard only.
**Status:** Open — one-click dashboard setting; do before onboarding real users.

### R-009: Supabase client pulls a Node API into the Edge middleware
**Risk:** The build warns that `@supabase/supabase-js` references `process.version`, "not supported in the Edge Runtime," via `middleware.ts` (which runs on Edge). It's a warning today (build + compile succeed), but a future Supabase/Next version could turn this into a hard failure or a runtime error in middleware.
**Mitigation:** Keep the middleware's Supabase usage minimal (session refresh only, already the case). If it ever errors at runtime, move the auth check out of Edge middleware or pin/adjust the Supabase version. Watch on the next dependency bump.
**Status:** Open — warning only, monitoring.

---

## Resolved
- **2026-07-07 (Sprint 0):** INC-2026-002 audit-integrity — tamper-proof `SECURITY DEFINER` audit trigger with an `auth.uid()` actor and no client write policy on `audit_logs`; approvals routed through the atomic `decide_approval()` RPC (migrations 0011/0013/0014, D-011). Proven in `database/tests/audit_verification.sql`.
- **2026-07-07 (Sprint 0):** R-003 secret-leak guardrail — gitleaks secret-scanning CI (`.github/workflows/ci-security.yml`), `.gitleaks.toml`, and `SECURITY.md`.
- **2026-07-07 (Sprint 0):** Repo↔live drift recurrence — migrations 0011–0014 were applied live but uncommitted; reconstructed byte-accurate from the Supabase migration ledger and committed to `database/migrations/`.
- **2026-07-07 (M8):** R-008 Next.js security pin — bumped `14.2.5` → `^14.2.5` (latest patched 14.2.x).
- **2026-07-07 (M8):** RLS enforcement verified live as a restricted user (supports R-001); role-gated writes + creator-or-admin deletes enforced (0010, supports R-005).
- **2026-07-07 (M7):** Repo↔live migration drift — migrations 0005–0010 written to `database/migrations/` to match the live schema.
- **2026-07-06 (M0):** Missing `.gitignore` (secret-leak risk under D-006) added before the first commit; Supabase advisor hardening (search_path pinned, anon RPC revoked) in migrations 0002/0003/0006.
