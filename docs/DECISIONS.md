# Mthryve OS — DECISIONS.md

Architectural decisions and the reasoning behind them. Add a new entry per decision — never edit history, append a superseding entry instead.

---

## D-001: Sequence Path A (artifacts) and Path B (Next.js/Supabase), don't pick one exclusively
**Date:** 2026-07-05
**Decision:** Keep using Claude.ai artifacts for daily operations while building the production Next.js/Supabase platform in parallel; migrate module by module.
**Why:** Freezing daily operations for 2+ months to build "the real thing" has a real cost — the artifacts are already load-bearing. But under-investing in real infra permanently caps what's possible (no real auth, no webhooks, no scale). Sequencing avoids both failure modes.
**Alternative considered:** Big-bang rebuild, artifacts frozen immediately. Rejected — too much operational risk for a 40+ person team relying on the current tools.

## D-002: Single-tenant schema, multi-tenant-shaped
**Date:** 2026-07-05
**Decision:** Include a `tenants` table and scope everything through `org_id`/`tenant_id` from day one, even though MVP has exactly one org (Mthryve).
**Why:** Retrofitting multi-tenancy into a single-tenant schema later means touching every table and every RLS policy. Building it in now costs almost nothing and directly serves the stated V3 ambition (sell the platform, not just use it).
**Alternative considered:** Single-tenant schema, add `tenant_id` later. Rejected — migration cost later is much higher than the marginal cost now.

## D-003: BD and E-Commerce Ops remain separate departments
**Date:** carried over from June 2026 audit work
**Decision:** Keep Business Development and E-Commerce Ops as separate department rows/dashboards rather than merging them under one BD umbrella.
**Why:** Already validated against real org structure during the audit; merging would misrepresent actual reporting lines and headcount.

## D-004: Universal metric set applied across all departments
**Date:** carried over from June 2026 audit work
**Decision:** GMV Impact, Efficiency, Quality Score, and Capacity Utilization apply uniformly across all 7 departments, rather than department-specific metric schemas.
**Why:** Enables cross-department comparison on the CEO dashboard without a translation layer; already validated during the real-data integration pass.

## D-005: AI never executes critical actions autonomously
**Date:** 2026-07-05 (formalizing existing master-brief principle)
**Decision:** Every AI-initiated action of consequence (task creation that assigns real work, report distribution, any write to `distributors`/`suppliers`/financial tables) goes through `approval_requests` and requires a human approve step. The AI can read and recommend without approval; it cannot write without it.
**Why:** This is a compliance-sensitive, multi-brand business (see distributor MLM compliance work) — an autonomous AI writing directly to production data is a liability, not a feature, at this stage of trust-building.
**Revisit when:** approval-queue data shows a sustained pattern (e.g. 3+ months) of near-100% approval rates for a specific action type, at which point auto-approval for that specific, narrow action type could be considered — decided explicitly here, not drifted into.

## D-006: Real API keys never committed or placed in artifacts
**Date:** carried over from prior integration work
**Decision:** All secrets (Claude API, Supabase, Zapier, TikTok/Shopee/Lazada credentials) live only in Vercel/Supabase environment variables, never in code, artifacts, or these docs.
**Why:** Security baseline; already established practice, formalized here so it survives the transition from artifacts to real infra.

## D-007: Supabase over separate Postgres + custom auth
**Date:** 2026-07-05
**Decision:** Use Supabase as the combined Postgres + Auth + Storage + Realtime provider rather than assembling these separately.
**Why:** Small team, no dedicated DevOps hire yet — one provider for data + auth + storage meaningfully reduces operational surface area versus self-hosting Postgres and rolling custom auth.
**Tradeoff accepted:** some vendor lock-in to Supabase-specific features (RLS syntax, Auth claims). Judged acceptable given team size; revisit only if Supabase becomes a genuine scaling bottleneck.

## D-008: Zapier for platform integrations, GitHub Actions for internal workflows
**Date:** carried over from prior integration audit
**Decision:** TikTok Shop, Shopee, Lazada, and Meta connect via Zapier (native connectors exist); GitHub Actions handles internal automation Zapier doesn't cover well (e.g. cross-module workflows inside Mthryve OS itself).
**Why:** Already identified as the practical bridge in prior work; avoids building custom API integrations for platforms with actively-maintained third-party connectors.

## D-009: Reuse existing Supabase project; accept the RLS-helper advisor warning
**Date:** 2026-07-06
**Decision:** (a) Adopt the pre-existing Supabase project `otepdjhrawtqkzclaxbk` (ap-northeast-1) as the live backend rather than creating a new one. (b) Keep `current_org_id()` / `current_user_role()` as `SECURITY DEFINER` functions in the `public` schema, executable by `authenticated`, accepting Supabase advisor lint 0029 ("signed-in users can execute SECURITY DEFINER function").
**Why:** (a) The project was empty and in the correct region for a PH-based company; reusing it is zero-cost and avoids a second project to manage. (b) RLS policy expressions are evaluated as the querying role, so `authenticated` *must* be able to execute these helpers for row-level security to work at all. The functions only ever return the caller's own `org_id`/`role` (never another user's), so exposure is limited to information the caller already has about themselves. All `search_path` and anon-exposure lints were remediated in migrations 0002/0003.
**Revisit when:** if the project needs isolation from other experiments in the same org, migrate to a dedicated project; if the RLS helpers ever return more than the caller's own scope, move them to a non-API-exposed schema.

## D-010: Pin Vercel functions to Tokyo (hnd1), co-located with the database
**Date:** 2026-07-07
**Decision:** Set `regions: ["hnd1"]` in `vercel.json` so serverless functions (server components, route handlers, middleware) run in Tokyo, next to the Supabase project (ap-northeast-1).
**Why:** Functions defaulted to `iad1` (US East) while the DB is in Tokyo and users are in the Philippines — so every page's several DB queries crossed the Pacific twice (~200ms each), which was the observed lag. Each page makes multiple queries, so DB round-trip latency dominates; co-locating the function with the DB collapses those to a few ms. Tokyo (hnd1) beats Singapore (sin1) here because minimizing the *multiplied* function↔DB latency matters more than shaving a little off the single user↔function hop (PH→Tokyo is still ~50–70ms).
**Tradeoff accepted:** Hobby plan allows one function region, so this optimizes for Asia; a US-based user would see slightly higher latency. Fine given the PH-based team. Revisit if the user base globalizes (Pro multi-region, or edge caching for read-heavy pages).

## D-011: Server-authoritative privileged writes + tamper-proof audit
**Date:** 2026-07-07
**Decision:** Privileged state changes never happen via direct client writes. (a) The audit trail is written by a `SECURITY DEFINER` trigger (`audit_privileged_change`, migration 0011) whose actor is always `auth.uid()`, and `audit_logs` carries no client write policy — so audit rows cannot be forged, altered, or deleted through the API, and the trigger function is not callable as an RPC (0011/0013). (b) Approval decisions go through a single `SECURITY INVOKER` RPC, `decide_approval()` (migration 0014), which validates the reviewer role, executes the proposed action, records the decision, and lets the audit trigger fire — atomically, under RLS. The approvals UI sends only `requestId`/`decision`/`note`.
**Why:** This resolves INC-2026-002. The prior approach let the browser insert the audit row and update the approval directly: the `actor_id` was whatever the client sent (forgeable), the audit write was silent and unverified, and the multi-step decision could partially fail. Moving the writes server-side makes the actor un-forgeable, the audit un-tamperable, and the decision atomic.
**Tradeoff accepted:** `decide_approval`'s action-execution logic now lives in SQL rather than TypeScript, so extending what "approve" executes means a migration, not just a component edit. Judged correct — the atomicity/integrity guarantee belongs in one transactional place. Revisit if approval action types proliferate enough to warrant a more general dispatch layer.
**Note:** `types/database.ts` was regenerated (2026-07-08) to include `decide_approval` and `brand_platform_metrics`; the `as never` casts on the RPC call and the platforms queries have been removed — those paths are now fully type-checked.

## D-012: Tiered AI model access, governed by the approval queue
**Date:** 2026-07-08
**Decision:** The AI assistant exposes three Anthropic model tiers — **lite = Claude Haiku** (default for every team member), **standard = Claude Sonnet** (department heads), **premium = Claude Opus** (CEO/COO). A team member or department head who needs a higher tier for a specific complex task requests it; the request runs through the existing approval queue (`decide_approval`, D-011), and once a CEO/COO approves, it unlocks that tier **for that task only — per-task approval, not a standing grant.** `/api/assistant` enforces the caller's effective tier on every call; usage is logged per model for cost visibility, with tighter caps on premium.
**Why:** Cost control + governance without sacrificing privacy. Staying entirely inside Anthropic (rather than adding OpenAI/Google/open models) keeps one API key, one privacy posture (Anthropic does not train on API data — material for an agency handling client data), and zero new secret surface right after the INC-2026-002 key work. Haiku is cheap enough to be the team's effective "free" tier. Reusing the approval + audit machinery means the governance layer is the one already hardened in Sprint 0 — request → approve → use → audit.
**Tradeoff accepted:** per-task approval maximizes control and audit but can load the CEO/COO if premium demand is high; if that bites, specific trusted people can be moved to time-boxed grants without a rebuild (the grant is data, not code). External free/open-source models are deferred — revisit only if a concrete need justifies the added key + data-governance review.
**Status:** Decided 2026-07-08; implementation is a V1.5 build (tiers + model picker + request→approve flow + per-model usage logging), sequenced after the platform-data sprint.

## D-013: Tony acts in two tiers, and is a two-tier identity — full Tony (CEO) vs. mini-Tony (everyone else)
**Date:** 2026-07-14
**Decision:** The grounded assistant gets a scoped ability to *act*, on the same request-scoped RLS client its read tools already use, in exactly two tiers:
- **Direct** (low-risk, self-scoped): `update_my_task_status` (a task assigned to the caller), `add_content_item` (a piece the caller owns), `pin_memory_note`. Each is a write RLS already permits the signed-in user to make; Tony makes it on their behalf and confirms in one line.
- **Proposed** (consequential): `propose_action` inserts a **pending** `action_requests` row into the existing Approval Queue (the same spine the signal producers use). A human approves in the existing queue; the existing executor runs it. Tony's job ends at "proposed."

And it is formalized as a **two-tier identity** driven entirely by the caller's role: **full "Tony"** is the CEO's assistant only (the name, full tool set, finance reach, cross-department scope, highest act tier); **"mini-Tony"** is everyone else — the *same engine and code path*, but role-filtered tools, RLS-walled data, and an act tier scaled by role.

**Hard rules (structural, not just prompt):**
1. **Money is never an executable action.** Finance/money proposals are recommendation-only `action_requests` carrying **no** `proposed_action`, so `decideActionRequest` skips the executor entirely and approval merely acknowledges them. There is no money-moving executor, and the executor refuses unknown types.
2. **External sends/posts are approval-gated *and* integration-gated.** SMTP/DM sending isn't wired up, so a "follow-up" reuses the `log_followup` executor, which stages the drafted message internally (logs an outreach activity + reschedules) and sends nothing. "Email/message this client" routes here as a staged draft.
3. **A team member's mini-Tony cannot create approval requests.** RLS `ar_insert` is ceo/coo/department_head only; the `propose_action` tool isn't even offered to `team_member`, and its prompt routes anything bigger than a direct self-scoped write as "I'll flag it for your department head." RLS remains the hard wall.
**Why:** Extends D-005 (AI never executes critical actions autonomously) from "recommend only" to "recommend + do the small self-scoped things a user could already do themselves, and *propose* the rest" — without ever giving the assistant execute power over consequential or money-moving actions. Reusing the `action_requests` spine + executor + audit means the governance layer is the one already hardened in D-011; no new tables, no new execution path. Making the identity split a pure function of role keeps one engine and one enforcement point (RLS), so a "mini-Tony" can never quietly out-reach its user.
**Alternative considered:** Let `propose_action` pass an arbitrary executor `type`+payload. Rejected — it would let the model smuggle a money/external action into an executable request; instead the propose tool exposes a fixed, curated set of proposal kinds, each mapped server-side to a safe internal executor or to recommendation-only.
**Revisit when:** SMTP/integration sending ships (then "send externally" becomes its own approval-gated, integration-gated executor, decided separately), or when direct-tier self-scoped writes prove they want a slightly wider, still-reversible surface.

## D-014: Tony reads from three memory sources, always grounded and cited
**Date:** 2026-07-14
**Decision:** Tony's retrieval is organized as one **READ tier** over three distinct sources, all queried through the caller's request-scoped RLS client on the existing tool-use loop (no new assistant):
1. **Live database** — real-time structured rows: `get_org_pulse`, `get_brand_status(brand)`, `get_department_plan(department)`, `list_my_work()`, and `get_finance_snapshot()`. This is the ONLY source of numbers.
2. **Knowledge base (RAG)** — uploaded company documents (SOPs, contracts, playbooks) via `search_knowledge(query)` → `searchKnowledge()` (Brief A), returning citable excerpts tagged with their source document title.
3. **Memory** — durable human-curated facts/decisions in `public.tony_memory` via `recall_memory(query|category)`.

The model decides which source(s) a question needs and may combine them. **Every fact is prefixed with its origin** ("From live data …", "From the &lt;document title&gt; …", "From memory …"); **empty retrieval yields "I don't have that yet", never a fabricated answer**; and **a figure from a document or memory is never quoted as a live number** — numbers come only from the live DB.

**Structural rules (not just prompt):**
- **Finance is omitted from the tool list for non-leadership** (`buildReadTools` adds `get_finance_snapshot` only for ceo/coo), so mini-Tony isn't even told it exists; the executor guards internally and RLS is the hard wall.
- **`searchKnowledge()` degrades to empty on any error** (including the `documents` table not existing yet), so a missing/empty Knowledge Base produces "not documented yet", never a crash and never a guess.
- The six legacy read tools the READ tier subsumes were **retired** (`get_kpi_summary`, `get_brand_performance`, `get_department_metrics`, `get_finance_summary`, `get_headcount`, `list_tony_memory`) to avoid a redundant, overlapping tool set the model would have to disambiguate; complementary reads (`list_brands`, `list_departments`, `get_returns_analysis`, `get_payroll_summary`, `get_pending_approvals`, `list_projects`) remain.
**Why:** A grounded assistant is only trustworthy if the user can tell *where* each fact came from and can rely on it never inventing one. Splitting retrieval into three explicitly-labelled sources — and making citation + the "numbers only from live DB" rule part of the contract — turns "don't hallucinate" from a hope into a structural property. Routing the knowledge source through a single `searchKnowledge()` seam (Brief A) keeps the RAG implementation swappable (keyword now, pgvector later) without touching the assistant.
**Alternative considered:** Keep all reads as one flat, unlabelled tool bag and rely on the prompt to ask for citations. Rejected — without a source label on each tool's output and an origin-prefix rule, the model blurs documented/remembered claims into live-fact phrasing, which is exactly the failure this decision prevents.
**Revisit when:** pgvector embeddings land (the semantic ranker slots in behind `searchKnowledge()` with no assistant change), or when a fourth retrieval source (e.g. live marketplace sync) warrants its own labelled origin.

## D-015: Vesper auto-clipping runs as a queued job + out-of-runtime worker, not in the app
**Date:** 2026-07-14
**Decision:** Vesper Studio (V4, in-house auto-clipping) is a **queued job model**. The Next.js app only enqueues jobs (`vesper_clip_jobs`) and runs the one pure-API stage (Anthropic highlight selection); a **standalone worker** (`worker/vesper-clipper.mjs`) does transcription (OpenAI Whisper) and ffmpeg clipping wherever ffmpeg is installed, writing results back with the **service role** (scoped by row id — same pattern as the fal completion writer). Every clip is surfaced as a `draft`/`idea` in Creative Studio; **nothing auto-publishes**.
**Why:** ffmpeg and multi-minute video processing cannot run in the Vercel serverless runtime — no ffmpeg binary, and function duration/memory/body limits make full-length livestream processing infeasible. Faking in-runtime processing (or silently truncating to tiny inputs) would be dishonest and would break on the first real livestream. A queue + worker is the standard, honest split and reuses the existing storage/content engine.
**Schema impact — deliberately minimal (audited against the live DB):** the only new object is the `vesper_clip_jobs` queue. Cut clips are ordinary `media_assets` rows in the existing `edited` folder, linked to their source via the existing `metadata` jsonb; clip drafts are `content_assets` with `kind='short_clip'` (that column is plain `text`, no CHECK) — so **no changes to `media_assets`/`content_assets` columns, constraints, or RLS** were required.
**No new paid keys:** transcription reuses `OPENAI_API_KEY`, segmentation reuses `ANTHROPIC_API_KEY`.
**Alternative considered:** a third-party auto-clipping SaaS, or running ffmpeg in a Vercel function via wasm. Rejected — a paid external service was out of scope ("in-house"), and ffmpeg.wasm can't handle long-form video within serverless limits. **Revisit when** a managed container/GPU host is standardized (the worker moves there unchanged) or auto-reframe/burned-in captions are prioritized. Full architecture in `docs/VESPER_STUDIO.md`.

## D-016: Vesper Reach — AI-drafted affiliate outreach is draft-only, approval-gated, and honest about sends
**Date:** 2026-07-18
**Decision:** The affiliate **Engage** surface gains **Vesper Reach**: Claude drafts creator outreach and replies, but the human governance line is unchanged — **drafting is the only automatic step, and NOTHING leaves `draft` without a leadership approval.**
- **Outbound** ("Draft with Vesper"): one Claude call per selected creator composes a personalized body from that creator's **real** `creators` fields (name/handle/platform/category/follower_count/tier/attributed_gmv/status/outreach_stage/notes) using the chosen `outreach_templates` row as the frame. **Unknown fields are omitted from the prompt entirely**, so Vesper can neither be told nor repeat a fabricated fact. Saved as `outreach_messages` `status='draft'`.
- **Inbound reply**: paste the creator's incoming message + pick the creator; Vesper drafts a tone-matched reply grounded only in that creator's real context, saved `status='draft'`.
- **Review → approve → send**: a unified queue (Vesper-drafted *and* hand-composed) allows inline edit while `draft`, then **Approve** stamps `approved_by`/`approved_at`. Send is channel-aware: **email** goes out via the app sender (`lib/outreach/email.ts`) only when `EMAIL_*`/`SMTP` is configured → `status='sent'`; **copy channels** (TikTok DM / Viber / …) have no send API, so they stage as **`ready_to_send`** with the approved text + a Copy button ("copy-to-send"), and a human confirms the hand-paste → `sent`. Either send path stamps `creators.last_contacted_at`, advances `outreach_stage` to `contacted` (never past it, never regressing), and logs an `outreach_activities` row.
- **Every Claude call is logged** to `ai_usage_log` (`recordAiUsage`, agent `vesper_reach`). A credit/billing failure surfaces as a calm **"AI credit needed"** inline note; a missing/rejected key surfaces as a config note — the flow **never crashes and never fakes a send**.

**⚑ CTO FLAG — DB migration owned by the assistant, NOT applied by it (code-only guardrail):** `public.outreach_messages_status_check` currently allows `('draft','approved','sent','failed','no_send_manual')` — it **lacks `ready_to_send`**. Migration **`database/migrations/20260718000000_outreach_ready_to_send_status.sql`** widens the CHECK to include it (additive, idempotent). Until a CTO applies it, `approveVesperMessage` catches the `23514` check-violation and **falls back to `approved`** for copy channels (still genuinely approved, still copy-to-send in the UI) — no crash, no silent failure. Applying the migration upgrades that label to the intended `ready_to_send`.

**Why:** The approval gate is the product's trust boundary; Vesper accelerates drafting without ever weakening it. Omitting unknown facts from the prompt (rather than instructing the model not to invent) makes "no fabrication" a structural property, not a hope. Honoring the missing DB state with a graceful fallback keeps the guardrail ("code-only, no Supabase DDL") intact while shipping a working feature.
**Alternative considered:** reuse the existing `no_send_manual` state instead of adding `ready_to_send`. Rejected — it conflates "copy-only, never sendable" with "approved and awaiting a hand-paste", and the spec calls for an explicit `ready_to_send`. **Revisit when** a real TikTok/Viber send API exists (those channels move onto the email-style app-send path) or when SMS gains a transport.

## D-017: GitHub Actions replaces automation as the automation scheduler
**Date:** 2026-07-29
**Decision:** Decommission automation and drive every scheduled automation from a single GitHub Actions workflow, `.github/workflows/automation-schedule.yml`. Three staggered jobs POST to the existing bearer routes — `tiktok-sync` → `/api/integrations/tiktok/sync` (06:00 Manila), `metrics-rollup` → `/api/automation/metrics-rollup` (06:20), `products-sync` → `/api/automation/products` (06:40) — each with `Authorization: Bearer ${{ secrets.AUTOMATION_API_KEY }}`, and each **fails the run on any non-2xx** (body echoed to the log). A fourth `staleness` job reads `max(stat_date)` from `tiktok_shop_performance` and goes RED when the data is >2 days behind today (Asia/Manila), so a dead scheduler surfaces as a red check instead of silence. `workflow_dispatch` (with a job picker + a staleness-threshold input) gives the CEO a no-terminal "Run now" button.
**Why:** The GitHub Actions cloud workspace was deleted ("No active workspace"); it was the ONLY scheduler firing these routes, so its loss stopped every sync **silently** (last good write `2026-07-28 22:04Z`). GitHub Actions is plan-independent — the same reason the auth heartbeat already lives there (Vercel Hobby rejects sub-daily cron at deploy-parse time), so **no `crons` block goes in `vercel.json`**. This supersedes the prior "GitHub Actions is NOT decommissioned, must stay running" stance in `INTEGRATION_PLAN.md`, which is now obsolete. The bearer routes and their auth are unchanged — only the driver moved.
**Known GitHub limitations, handled explicitly:** (1) GitHub auto-disables `schedule` triggers after 60 days with no repo commits — if it does, nothing fires (including `staleness`), so the in-product watchdog `/api/automation/sync-health-check` remains as an independent leadership alert, and the fix is Actions → "Enable workflow" or any commit; (2) scheduled runs are best-effort and can drift/skip under load — the daily windows and the `staleness` job's 2-day tolerance absorb a single missed tick. Both are documented in the workflow header and `INTEGRATION_PLAN.md`.
**Secret surface:** the sync jobs receive only `AUTOMATION_API_KEY` (as GitHub Actions did). The `staleness` job additionally needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, because `tiktok_shop_performance` is org-scoped RLS and reading `max(stat_date)` across all orgs requires the service role. This is a new (read-only) use of the service key in CI, scoped to that one job.
**Alternative considered:** stand up a new automation instance, or add a bearer freshness route so CI never holds the service key. Rejected for now — a fresh automation instance is another external single point of failure to babysit, and adding a route was out of scope for this incident fix (and would need a deploy to verify). **Revisit** the service-key-in-CI tradeoff if a bearer-authed freshness endpoint is added later; the `staleness` job would then drop the Supabase secrets and hit that route instead.
