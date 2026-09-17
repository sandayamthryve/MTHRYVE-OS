# Mthryve OS — ROADMAP.md

Milestones, not dates — sequence each phase off the previous one shipping, since the team is small and this runs alongside daily operations, not instead of it.

---

## MVP — "A normal workday runs inside the OS"

**Goal:** replace spreadsheets + group chats for daily task management, approvals, and reporting.

- [ ] Auth (invite-only registration, login, role-based permissions, session management)
- [ ] Org/department/brand/user schema live in Supabase with RLS
- [ ] CEO, Department Head, Employee dashboards (read-only metrics + task lists to start)
- [ ] Task Management (projects → tasks → subtasks, assignment, due dates, comments, attachments, status)
- [ ] Knowledge Base v1 (upload + storage; AI search can come slightly after upload works)
- [ ] AI Assistant v1: chat + knowledge search only (no task generation yet — prove the basics first)
- [ ] Approvals v1: manual approval queue (AI proposal generation can follow once the assistant is trusted)
- [ ] Reports v1: manually-triggered weekly report, auto-generated from `metrics_snapshots`
- [ ] Deployed to Vercel, usable daily by at least CEO + one Department Head

**Exit criteria:** you personally run one full week of Mthryve operations using the OS instead of spreadsheets, and it doesn't break.

---

## V1.5 — "The AI actually helps"

- [ ] AI task generation (assistant drafts tasks from a prompt or meeting note; human assigns/approves)
- [ ] AI meeting summary (upload a recording/transcript → structured summary + action items)
- [ ] Approval workflow becomes AI-initiated: AI proposes → manager approves → task executes → AI monitors → AI reports (full loop from the master brief)
- [ ] Knowledge Base semantic search (pgvector embeddings live)
- [ ] Audit logs visible to CEO/COO

**Exit criteria:** the AI assistant generates at least 30% of new tasks, all still human-approved.

---

## V2 — "Every department, every platform"

- [ ] TikTok Shop integration (via Zapier)
- [ ] Shopee integration (via Zapier)
- [ ] Lazada integration (via Zapier)
- [ ] Meta integration
- [ ] Warehouse module (inventory, fulfillment error tracking — closes the "recurring fulfillment errors" gap from the June audit)
- [ ] Finance module (basic P&L per brand, cost tracking — real team cost data already validated, wire it in)
- [ ] CRM module
- [ ] Reports become fully automated (daily/weekly/monthly, zero manual trigger)

**Exit criteria:** brand-level GMV, cost, and fulfillment data flow into the OS automatically, not via manual spreadsheet import.

---

## V3 — "The platform Mthryve sells, not just uses"

- [ ] Affiliate Marketplace (migrate from Creator/Affiliate Portal artifact)
- [ ] Supplier Portal (migrate from Supplier Portal artifact)
- [ ] Distributor Portal (migrate from Distributor Dashboard artifact, compliance fields already schema-ready)
- [ ] Multi-Tenant SaaS (other agencies/brands onboard as tenants — this is where `tenants` table earns its keep)
- [ ] Deep Search competitor intelligence, promoted from artifact to full module if usage justifies it

**Exit criteria:** a second organization (not Mthryve) could onboard onto the platform without custom engineering.

---

## Explicitly Out of Scope for MVP

- Multi-tenant billing/plans
- Public-facing marketing site
- Mobile app (responsive web is sufficient for MVP)
- "Jarvis"-style wearable assistant (already flagged as a Phase 3 stretch goal in the AI training program, not part of this build)
