# Mthryve OS — GitHub Issue List

Paste directly into GitHub Issues, one `###` block per issue. Grouped by milestone — create matching GitHub Milestones with these exact names first, then assign issues.

---

## Milestone: 0 - Foundation

### Set up core infrastructure (repo, Supabase, Vercel)
Create GitHub repo with branch protection on `main`. Create Supabase project. Create Vercel project connected to repo with preview deploys enabled.
**Labels:** infra, priority-high

### Scaffold Next.js app structure
Initialize Next.js (App Router) + TypeScript + Tailwind per folder structure in `docs/PROJECT.md` §6.
**Labels:** infra, priority-high

### Configure Tailwind dark theme tokens
Port charcoal/teal/green/gold design tokens from existing artifacts into `tailwind.config`.
**Labels:** frontend, design

### Write initial DB migration: org structure
Migration for `tenants`, `organizations`, `departments`, `brands`, `users`, `roles` per schema in `PROJECT.md` §5.
**Labels:** database, priority-high

### Set up RLS policies for org-scoped tables
RLS policies scoping every table by `org_id`. Add policy tests (see risk R-001 in `BUGS.md`).
**Labels:** database, security, priority-high

### Seed database with real Mthryve org data
Seed 7 departments and 10 brands (FML, Alianna's Choice, Namiroseus Main, Crayola Philippines, Basic City, Liao Philippines, Standard Philippines, Vitachums, Star 360 [inactive], Amazing Pharma Corporation).
**Labels:** database

---

## Milestone: 1 - Auth

### Integrate Supabase Auth
Email/password + magic link. Wire into Next.js middleware for route protection.
**Labels:** auth, priority-high

### Build invite-only registration flow
No public sign-up. Invite generates account, sets initial role.
**Labels:** auth

### Implement role-based route guards
Department Head sees only their department; Team Member sees only assigned items; CEO/COO see all.
**Labels:** auth, security

### Build login/registration UI
Dark theme, matches existing artifact design language.
**Labels:** frontend

---

## Milestone: 2 - Dashboards

### Build CEO dashboard
Cross-department metrics summary (GMV Impact, Efficiency, Quality Score, Capacity Utilization).
**Labels:** frontend, dashboard

### Build Department dashboard
Department-scoped tasks + metrics, parameterized by department ID.
**Labels:** frontend, dashboard

### Build Employee dashboard
Personal task list + assigned items.
**Labels:** frontend, dashboard

### Build shared app shell
Search, notifications, AI assistant entry point, profile menu, breadcrumb — present on every page.
**Labels:** frontend

---

## Milestone: 3 - Task Management

### Migration: projects and tasks schema
Per `PROJECT.md` §5 Task Management tables.
**Labels:** database

### Task CRUD
Create, edit, assign, change status.
**Labels:** backend, frontend

### Subtasks support
**Labels:** backend, frontend

### Task comments
**Labels:** backend, frontend

### Task attachments via Supabase Storage
**Labels:** backend, frontend

### Task list view: filter/sort by priority, due date, assignee
**Labels:** frontend

### Kanban board view
**Labels:** frontend

### Brand-linkage tagging on tasks
Preserve brand-tag pattern from existing artifacts.
**Labels:** backend, frontend

---

## Milestone: 4 - Knowledge Base

### Document upload to Supabase Storage
PDF, Excel, Word, PPTX, images.
**Labels:** backend

### Text extraction pipeline
Extract text per file type into `extracted_text`.
**Labels:** backend

### Basic keyword search across documents
**Labels:** backend, frontend

### pgvector semantic search
Flag for V1.5 if MVP timeline is tight.
**Labels:** backend, ai

### Document tagging UI
**Labels:** frontend

---

## Milestone: 5 - AI Assistant v1

### Claude API server-side integration
Route handler only — key never exposed client-side.
**Labels:** backend, ai, security

### Chat UI with persistent history
**Labels:** frontend, ai

### Wire knowledge base search as an assistant tool
**Labels:** backend, ai

### Rate limiting / cost guardrails on AI route
See risk R-004 in `BUGS.md`.
**Labels:** backend, ai, priority-high

---

## Milestone: 6 - Approvals v1

### Migration: approval_requests schema
**Labels:** database

### Approval queue UI
Department Head / CEO view.
**Labels:** frontend

### Approve/reject actions with audit logging
**Labels:** backend, security

---

## Milestone: 7 - Reports v1

### Migration: metrics_snapshots and reports schema
**Labels:** database

### Weekly report generation (manual trigger)
**Labels:** backend

### Report viewing UI with department/brand filters
**Labels:** frontend

---

## Milestone: 8 - Testing & Hardening (ongoing, not a phase)

### RLS policy test suite
**Labels:** testing, security, priority-high

### Auth flow integration tests
**Labels:** testing

### UI smoke tests per dashboard
**Labels:** testing

---

## Milestone: 9 - Launch

### Production deploy to Vercel
**Labels:** infra, priority-high

### Onboard first real users (CEO + 1 Department Head)
**Labels:** launch

### Run first full operational week, log friction to BUGS.md
**Labels:** launch
