# Mthryve OS — PROJECT.md

**Tagline:** The AI Operating System for Ecommerce Businesses
**Owner:** Wolfie, CEO, Mthryve Marketing Inc.
**Status:** Pre-build / Architecture approved pending final path decision
**Last updated:** 2026-07-05

---

## 1. Vision

Mthryve OS replaces the disconnected spreadsheets, chat threads, and single-purpose tools currently running Mthryve Marketing Inc. with one system that manages every department — Live Operations, Creative, Affiliate Marketing, Business Development, E-Commerce Ops, HR & Admin, and Warehouse & Fulfillment — across a 10-brand, multi-platform (TikTok Shop, Shopee, Meta) portfolio.

**Success metric:** a normal Mthryve workday can be executed entirely inside the OS — task assignment, approvals, reporting, affiliate management, supplier/distributor coordination — without falling back to spreadsheets or group chats.

The long-term ambition is bigger than a dashboard: Mthryve OS is meant to be an **AI-first operating system**, where a company AI assistant recommends, humans approve, and the system executes and reports — not just a UI over a database.

---

## 2. Two Viable Paths (and why this document covers both)

Work to date (Department Command Center, Deep Search, Creator/Affiliate Portal, Supplier Portal, Distributor Dashboard) has been built as **Claude.ai React artifacts** using a shared `window.storage` key-value layer. The new master build brief specifies a **Next.js + Supabase + Postgres + Vercel + GitHub** production stack. These are genuinely different products, not two skins on the same thing, so both are documented here rather than silently picking one.

### Path A — Artifact-Native OS (current approach, extended)
Continue building each module as a Claude.ai React artifact, all sharing `window.storage` key prefixes (already the working pattern across your 5 artifacts).

**Pros**
- Already working today; zero infra, zero hosting cost, zero deploy step
- You (or anyone with Claude access) can keep building/editing live in chat
- Fast iteration — no build pipeline, no auth setup, no environment variables
- Good fit for internal tools with a small, trusted user base

**Cons**
- No real authentication — anyone with the artifact link has access
- `window.storage` is not a real relational database: no joins, no complex queries, 5MB per key, no transactions
- Can't run scheduled jobs, webhooks, or real integrations (TikTok/Shopee/Zapier callbacks need a real server)
- Not independently deployable to a company domain; lives inside Claude.ai
- Doesn't scale cleanly past internal single-tenant use

### Path B — Production Platform (Next.js + Supabase + Postgres + Vercel)
Build as specified in the master brief: real repo, real database, real auth, real deploy.

**Pros**
- Real RBAC, real multi-tenant data isolation, real audit logs
- Can actually receive webhooks from TikTok Shop / Shopee / Lazada / Zapier
- Scales to the "leading AI-powered agency in the Philippines" ambition — client-facing, multi-tenant SaaS is possible later
- Own domain, own infra, own data — no dependency on Claude.ai as a hosting surface

**Cons**
- Requires a real GitHub repo, Supabase project, and Vercel project that **you** (or a developer) provision and hold credentials for — I cannot create these accounts, push commits, or deploy on your behalf from this chat
- Meaningfully longer time-to-first-useful-version than an artifact
- Needs ongoing DevOps: migrations, env vars, CI, monitoring
- Introduces real security surface area (auth, secrets, RLS policies) that has to be gotten right

### Recommendation

**Run both, sequenced, not simultaneous:**

1. **Now → next 4–6 weeks:** Keep shipping Path A artifacts for the modules that are working (Command Center, Deep Search, Creator Portal, Supplier Portal, Distributor Dashboard). This is your live internal tool today — don't stop using it while the real platform is built.
2. **In parallel, start Path B as the target production platform**, beginning with auth + the database schema + the single highest-value module (recommend: Task Management + Department Dashboards, since that's what "a normal workday" runs on).
3. **Migrate module by module** from artifact → production app, using the artifact versions as working prototypes/spec for what each screen needs to do. Don't rebuild from a blank page — the artifacts already encode your real requirements (brand tags, universal metrics, RBAC needs).
4. **Retire `window.storage` once Postgres is live** for that module; keep artifacts only for anything that stays experimental (e.g. Deep Search competitor intel is a good candidate to stay artifact-based longer, since it's read-heavy and low-stakes).

This avoids two failure modes: freezing daily operations while waiting 2+ months for a "proper" platform, and permanently under-investing in real infrastructure because the artifacts are "good enough for now."

All documents below (`ROADMAP.md`, `TODO.md`, `AI_AGENTS.md`) are written for **Path B**, since that's the direction you confirmed for this pass — with migration notes pointing back to the existing artifacts where relevant.

---

## 3. Tech Stack (Path B)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js (App Router) + React + TypeScript | Server components for dashboards, client components for interactive widgets |
| Styling | Tailwind CSS | Dark brand theme: charcoal, teal, green, gold (from feather logo) — carry over design tokens from existing artifacts |
| Backend | Supabase (Postgres + Auth + Storage + Realtime) | Single provider reduces DevOps surface for a small team |
| Database | PostgreSQL (via Supabase) | Fully normalized, see schema below |
| Auth | Supabase Auth | Email/password + magic link; role claims via custom claims / RLS |
| AI | Claude API (Sonnet-class model) | Single company assistant, tool-using, human-approval gated for any write action |
| Automation | GitHub Actions + Zapier | Zapier for TikTok Shop / Shopee / Lazada / Meta connectors (per your earlier audit finding — native connectors exist for these); GitHub Actions for internal workflow automation Zapier doesn't cover |
| Deployment | Vercel | Preview deploys per PR, production on `main` |
| Repo | GitHub | Trunk-based, protected `main`, PR required |

**Security note carried over from prior work:** real API keys are never committed or placed in artifacts. All secrets live in Vercel/Supabase environment variables, referenced by name only in code and docs.

---

## 4. Core Modules (MVP scope)

1. **Authentication** — login, registration (invite-only), role-based permissions, session management
2. **Dashboards** — CEO, Department Head, Employee views, each scoped by role
3. **AI Assistant** — single company assistant: chat, knowledge search, meeting summary, report generation, strategy suggestions, task generation, document search
4. **Task Management** — projects, tasks, subtasks, priority, due dates, comments, attachments, status, assignment
5. **Knowledge Base** — upload PDF/Excel/Word/PPTX/images, AI-powered search across all of it
6. **Approvals** — AI proposes → manager approves → task executes (no autonomous critical actions, ever)
7. **Reports** — daily/weekly/monthly, auto-generated from task + metrics data

**Post-MVP features** (scoped in `ROADMAP.md`): TikTok/Shopee/Lazada integrations, Warehouse, Finance, CRM, Affiliate Marketplace, Supplier Portal, Distributor Portal, Multi-Tenant SaaS.

---

## 5. Database Schema (Path B, normalized Postgres)

Every table includes `created_at`, `updated_at`, `created_by`, `status` unless noted. This is the MVP schema — extend, don't fork, as features land.

### Identity & Org
- **tenants** `(id, name, plan, brand_theme jsonb)` — future-proofs multi-tenant even though MVP is single-tenant (Mthryve only)
- **organizations** `(id, tenant_id, name)` — Mthryve Marketing Inc. as the first org
- **departments** `(id, org_id, name, lead_user_id)` — Live Ops, Creative, Affiliate Marketing, BD, E-Commerce Ops, HR & Admin, Warehouse & Fulfillment
- **brands** `(id, org_id, name, platform_focus text[], gmv_share numeric)` — FML, Alianna's Choice, Namiroseus Main, Crayola Philippines, Basic City, Liao Philippines, Standard Philippines, Vitachums, Star 360 (status: inactive), Amazing Pharma Corporation
- **users** `(id, org_id, department_id, full_name, email, role, avatar_url)`
- **roles** `(id, name, permissions jsonb)` — CEO, COO, Department Head, Team Member, etc.

### Task Management
- **projects** `(id, org_id, department_id, brand_id nullable, name, description, owner_id, due_date)`
- **tasks** `(id, project_id, parent_task_id nullable, title, description, assignee_id, priority, due_date, status)`
- **task_comments** `(id, task_id, author_id, body)`
- **task_attachments** `(id, task_id, file_url, file_type)`

### Knowledge Base
- **documents** `(id, org_id, uploaded_by, file_url, file_type, title, extracted_text, embedding vector)` — `embedding` column for AI semantic search (pgvector)
- **document_tags** `(document_id, tag)`

### Approvals
- **approval_requests** `(id, org_id, requested_by_agent, action_type, payload jsonb, status, reviewed_by, reviewed_at)`

### Reports & Metrics
- **metrics_snapshots** `(id, org_id, department_id, brand_id nullable, gmv_impact, efficiency, quality_score, capacity_utilization, period_start, period_end)` — the universal metric set already defined in prior audit work
- **reports** `(id, org_id, type, period_start, period_end, generated_by, content jsonb)`

### AI & Automation
- **ai_conversations** `(id, org_id, user_id, title)`
- **ai_messages** `(id, conversation_id, role, content, tool_calls jsonb)`
- **integrations** `(id, org_id, provider, status, config jsonb)` — TikTok Shop, Shopee, Lazada, Meta, Zapier, GitHub Actions
- **audit_logs** `(id, org_id, actor_id, action, target_table, target_id, diff jsonb)`

### Portals (post-MVP, scoped now for schema stability)
- **affiliates** `(id, org_id, name, tier, commission_rate)`
- **suppliers** `(id, org_id, name, category, contact_info jsonb)`
- **distributors** `(id, org_id, name, tier, upline_id, compliance_status)` — carries over the DTI/SEC/FDA compliance fields from the existing Distributor Dashboard artifact

**Row-Level Security:** every table scoped by `org_id` (and `tenant_id` once multi-tenant matters). Department Heads see their department; CEO/COO see all; Team Members see only their assigned tasks/projects. RLS policies live in `DECISIONS.md` once written, since RLS design is itself an architectural decision with tradeoffs.

---

## 6. Folder Structure (Path B)

```
mthryve-os/
├── app/                      # Next.js App Router pages
│   ├── (auth)/               # login, register
│   ├── (dashboard)/
│   │   ├── ceo/
│   │   ├── department/[id]/
│   │   └── employee/
│   ├── tasks/
│   ├── knowledge-base/
│   ├── approvals/
│   ├── reports/
│   └── api/                  # route handlers (webhooks, AI proxy)
├── components/                # shared UI components
│   ├── ui/                    # design-system primitives
│   └── layout/                # shell, nav, breadcrumb
├── features/                  # feature-scoped logic + components
│   ├── tasks/
│   ├── knowledge-base/
│   ├── approvals/
│   ├── ai-assistant/
│   └── reports/
├── lib/                        # cross-cutting utilities (supabase client, auth helpers)
├── hooks/                      # shared React hooks
├── services/                   # external API clients (Claude, Zapier, GitHub Actions, TikTok/Shopee)
├── types/                      # shared TypeScript types
├── database/                   # SQL migrations, seed scripts
├── public/
├── docs/                        # PROJECT.md, ROADMAP.md, DECISIONS.md, etc. live here
└── tests/
```

---

## 7. Migration Notes from Existing Artifacts

- **Design tokens** (charcoal/teal/green/gold dark theme) — port directly into `tailwind.config`
- **Universal metric set** (GMV Impact, Efficiency, Quality Score, Capacity Utilization) — already schema-ready above as `metrics_snapshots`
- **Brand-linkage tags on bottlenecks/action items** — preserved as `brand_id` foreign keys throughout
- **BD vs. E-Commerce Ops kept separate** — preserved as separate `departments` rows, not merged
- **Distributor compliance fields** (DTI/SEC/FDA, 80%+ real-sales conditional check) — preserved on `distributors` table; the "conditional pending live transaction data" status becomes a real, queryable `compliance_status` value once real transaction data flows in via Shopify/Zapier

See `BUGS.md` for open risks and `DECISIONS.md` for why each of these calls was made.
