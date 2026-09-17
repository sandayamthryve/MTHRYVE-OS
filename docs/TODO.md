# Mthryve OS — TODO.md

Prioritized backlog for MVP. Grouped by milestone (matches `ROADMAP.md`), ordered within each group by dependency, not by ease.

---

## Milestone 0: Foundation (must exist before any feature work)
- [x] Create Supabase project (Postgres + Auth + Storage) — reused `otepdjhrawtqkzclaxbk` (Tokyo)
- [x] Scaffold Next.js app with folder structure from `PROJECT.md` §6
- [x] Configure Tailwind with Mthryve dark theme tokens (charcoal/teal/green/gold)
- [x] Write initial SQL migration: `tenants`, `organizations`, `departments`, `brands`, `users` — applied live
- [x] Set up RLS policies for org-scoped tables — applied + advisor-hardened (0002/0003)
- [x] Seed database with real Mthryve org structure (7 departments, 10 brands from audit) — verified live
- [x] Auto-provision `public.users` profile on signup (0004) — trigger verified live
- [x] Local env wired to live backend (`app/.env.local`, gitignored)
- [ ] **[USER]** Install Node.js 20+ locally OR push repo to GitHub (needed to build/run/deploy — see README "Getting it running")
- [ ] **[USER]** Create GitHub repo + push, set up branch protection on `main`
- [ ] **[USER]** Create Vercel project, connect to repo, configure preview deploys
- [ ] **[USER]** Set env vars in Vercel (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`)

## Milestone 1: Auth
- [x] Supabase Auth integration (email/password) — login wired to live project
- [x] Session management (middleware-protected routes) — middleware + `requireProfile`
- [x] Role-based route guards (department head sees only their department, etc.) — `requireRole` + per-page guards
- [x] Role assignment on signup (CEO, COO, Department Head, Team Member) — via invite metadata + 0004 trigger
- [x] Login UI (dark theme) + working sign-out
- [ ] Magic-link sign-in option (password-only for now)
- [ ] In-app invite flow UI (currently: create users in Supabase dashboard with role metadata — see app/README)

## Milestone 2: Dashboards
- [x] CEO dashboard shell reading live org data (departments, brands, GMV) — metric rollups pending Milestone 7
- [x] Department dashboard: department-scoped, RBAC-guarded (tasks/metrics pending M3/M7)
- [x] Employee dashboard: personal workspace resolving identity + department (task list pending M3)
- [x] Shared shell: breadcrumb, search, notifications, AI assistant entry, profile + sign-out (every page)
- [ ] Wire real metrics (GMV Impact, Efficiency, Quality Score, Capacity Utilization) once `metrics_snapshots` lands (M7)
- [ ] Make search + notifications functional (currently static affordances)

## Milestone 3: Task Management
- [x] `projects` and `tasks` schema + migrations (0005) — applied live, RLS + indexes
- [x] Task CRUD (create/edit/assign/status change) — board create + inline status/priority/assignee
- [x] Subtasks — self-referential `parent_task_id`, add inline on detail
- [x] Comments on tasks — add + list on detail
- [x] Priority + due date fields, list view
- [x] Brand-linkage tagging on tasks
- [ ] Attachments file upload via Supabase Storage (schema table exists; upload UI pending — needs a Storage bucket)
- [ ] Kanban board view (list view shipped; drag-and-drop board is a follow-up)
- [ ] Task editing of title/description after creation (status/priority/assignee editable now)
- [ ] Finer-grained write RBAC (currently any org member can edit; see BUGS R-005)

## Milestone 4: Knowledge Base
- [ ] Document upload (PDF, Excel, Word, PPTX, images) to Supabase Storage
- [ ] Text extraction pipeline (PDF/Word/PPTX → `extracted_text`)
- [ ] Basic keyword search across documents
- [ ] pgvector embeddings + semantic search (can land in V1.5 if MVP timeline is tight — flag if deferring)
- [ ] Document tagging

## Milestone 5: AI Assistant v1
- [x] Claude API integration (server-side route handler, key in env vars only) — `claude-opus-4-8` via `/api/assistant`
- [x] Chat UI (persistent conversation history per user) — `/assistant` loads latest conversation
- [x] Conversation + message schema (`ai_conversations`, `ai_messages`) — migration 0007, user-scoped RLS
- [x] Rate limiting / cost guardrails on the API route — 100 msgs/user/day + 4000-char input cap
- [ ] **[USER]** Add `ANTHROPIC_API_KEY` to the Vercel project (assistant returns a clear "not configured" error until then)
- [ ] Knowledge base search tool wired to assistant (needs Milestone 4 first)
- [ ] Streaming responses (currently one-shot); model-usage logging for cost visibility

## Milestone 6: Approvals v1
- [x] `approval_requests` + `audit_logs` schema (migration 0008, org-scoped RLS; review restricted to ceo/coo/dept-head)
- [x] Manual approval queue UI (`/approvals`) — pending, decided history, propose-a-task form
- [x] Approve/reject actions with reviewer + timestamp; **executes on approve** (creates the task) — closes the D-005 loop
- [x] Audit log entry on every decision; audit trail visible to CEO/COO
- [ ] Wire AI-generated proposals into the queue (needs assistant task-generation, V1.5)
- [ ] Approval routing by department/action-type (AI_AGENTS Agent 3)

## Milestone 7: Reports v1
- [x] `metrics_snapshots` schema + manual ingestion (migration 0009; entry restricted to ceo/coo/dept-head)
- [x] Weekly report generation (manually triggered) — rolls up last 7 days into a `reports` row
- [x] Report viewing UI (`/reports`) — org rollup, per-department metrics table, expandable generated reports
- [x] `reports` schema for storing generated report content (jsonb)
- [x] Wired live metrics into CEO + department dashboards (replaced the M7 placeholders)
- [ ] Automated ingestion from TikTok/Shopee via Zapier (V2); AI-drafted report narratives (V1.5); brand-level filtering

## Milestone 8: Testing & Hardening (continuous, not a phase at the end)
- [x] RLS policy verification against the live DB (`database/tests/rls_verification.sql`) — isolation + write-denial proven as a team_member
- [x] Fix Next.js security pin (R-008) — `^14.2.5`
- [x] Tighten delete RBAC (migration 0010) — creator-or-admin only
- [x] Every table has org-scoped RLS; Supabase security advisor clean (2 intentional warnings)
- [x] Secret-scanning in CI (gitleaks on every push/PR) — `.github/workflows/ci-security.yml` + `.gitleaks.toml` + `SECURITY.md` (R-003) (Sprint 0)
- [x] Tamper-proof audit trail + atomic approval RPC (INC-2026-002) — migrations 0011/0013/0014, verified `database/tests/audit_verification.sql` (Sprint 0, D-011)
- [x] Regenerate `types/database.ts` (through migration 0015 + `decide_approval`) preserving the hand-added aliases; dropped the `as never` casts in `ApprovalActions.tsx` and the platforms page/import (2026-07-08)
- [ ] **[USER]** Enable Supabase leaked-password protection (dashboard; R-010)
- [ ] Automated test suite that runs in CI (needs Node + a test DB — deferred until local tooling exists)
- [ ] UI smoke tests / manual QA pass per feature

## Milestone 9: Launch
- [ ] Deploy to production Vercel environment
- [ ] Onboard CEO + at least one Department Head as first real users
- [ ] Run one full operational week inside the OS (MVP exit criteria from `ROADMAP.md`)
- [ ] Collect friction points → feed into `BUGS.md` and next sprint's `TODO.md`

---

## Deferred (V1.5+, tracked so they aren't lost, not started yet)
- AI task generation from prompts/meeting notes
- AI meeting summarization
- Full AI propose→approve→execute→monitor→report loop
- Semantic knowledge base search (if deferred from MVP)
- TikTok/Shopee/Lazada/Meta integrations
- Warehouse, Finance, CRM modules
- Affiliate Marketplace, Supplier Portal, Distributor Portal migrations from artifacts
- Multi-tenant SaaS activation
