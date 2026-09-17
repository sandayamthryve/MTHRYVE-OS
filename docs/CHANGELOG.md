# Mthryve OS — CHANGELOG.md

All notable completed work, newest first. This file tracks what has actually shipped — planned work lives in `TODO.md`/`ROADMAP.md`, not here.

Format: `## [date] — short summary`, followed by bullet list of changes.

---

## [2026-07-29] — GitHub Actions replaces automation as the automation scheduler
- **`.github/workflows/automation-schedule.yml` (new).** GitHub Actions's cloud workspace was deleted ("No active workspace") — it was the ONLY scheduler firing the automation routes, so its loss stopped every sync **silently** (last good write `2026-07-28 22:04Z`, `tiktok_shop_performance` frozen at `stat_date = 2026-07-28`). This workflow is the replacement driver. Four jobs, `schedule` + `workflow_dispatch`: **`tiktok-sync`** `0 22 * * *` → `POST /api/integrations/tiktok/sync` (06:00 Manila), **`metrics-rollup`** `20 22 * * *` → `POST /api/automation/metrics-rollup` (06:20), **`products-sync`** `40 22 * * *` → `POST /api/automation/products` (06:40), each with `Authorization: Bearer ${{ secrets.AUTOMATION_API_KEY }}`.
- **Fails loudly.** Each sync job captures the HTTP status + body: a non-2xx turns the run **RED** and echoes the response body into the log (curl is not allowed to swallow it). A silent green check on a failed sync — GitHub Actions's exact failure mode (a 200-from-`/login`-bounce reported as "success" while 0 rows landed) — is engineered out.
- **`staleness` job (new tripwire)** `50 22 * * *` → reads `max(stat_date)` from `tiktok_shop_performance` via the Supabase REST API and goes **RED when the data is >2 days behind today (Asia/Manila)**, so a dead/auto-disabled scheduler surfaces as a red check instead of silence. On manual dispatch the threshold is an input — `0` forces a RED drill.
- **No-terminal "Run now."** `workflow_dispatch` exposes a job picker (`all` / any single job) and a staleness-threshold input — the CEO's button, no terminal needed. The admin "Run now" panel (separate PR) hits the same bearer routes.
- **GitHub limitations documented + handled:** scheduled workflows auto-disable after 60 days of no repo commits, and scheduled runs are best-effort (can drift/skip). Both are called out in the workflow header and `INTEGRATION_PLAN.md`; the in-product watchdog `/api/automation/sync-health-check` stays as an independent leadership alert for the auto-disable case, and the `staleness` job's 2-day tolerance absorbs a single missed tick.
- **Unchanged by design:** the bearer routes and their constant-time auth, the `auth-e2e` workflow, and the `auth-heartbeat`. Only the *driver* moved from GitHub Actions to GitHub Actions. New secrets: `AUTOMATION_API_KEY` (sync jobs, as GitHub Actions held), plus `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` used ONLY by the read-only `staleness` probe (the table is org-scoped RLS). Docs: `INTEGRATION_PLAN.md` (Automation drivers rewritten — GitHub Actions decommissioned), `DECISIONS.md` D-017.

---

## [2026-07-28] — metrics_snapshots rollup writer: department health, automated
- **`lib/metrics/rollup.ts` (new).** Folds the OS's own live rows into ONE `metrics_snapshots` row per `(org_id, department_id, period)` plus an org-level roll-up row — the metrics analogue of the daily TikTok sync (same shape, same idempotent-upsert discipline, same `source`/`synced_at` stamping, same Manila "period ending yesterday" window). `gmv_impact` is **real revenue from `tiktok_shop_performance`, the ONE GMV source of truth (PR 1 / PR 3)**, read through the SAME range-aware helper every commerce surface uses (`lib/metrics/tiktok-live`: `getLiveDaysByBrand` + `sumOrgGmvWindow`) — so department health reconciles with the Command Center **by construction**. Commerce GMV is attributed to the department that owns commerce (E-Commerce Ops); the org-level row rolls from the same figure; departments with no revenue attribution stay `0`. **GMV is never sourced from `metric_entries`** (a manual-entry ledger, not a revenue source — sourcing it there was the exact non-reconciling second-source defect PR 3 removed). `efficiency` and `quality_score` **reuse the exact pure derivations from `lib/metrics/signals.ts`** (`efficiencyFrom`/`qualityFrom`, now exported) so a snapshot can never drift from the live dashboard; the writer fetches each org's rows service-role + org-scoped (the TikTok machine pattern) rather than leaning on RLS. `capacity_utilization` is an **honest NULL** (renders "—") until a load-vs-headcount definition is ratified — never a fabricated 0 or 100.
- **`app/api/automation/metrics-rollup/route.ts` (new).** Bearer-authed with the **same constant-time block copied from `/api/integrations/tiktok/sync`** (accepts `CRON_SECRET` **or** `AUTOMATION_API_KEY`); a leadership session may also run it, scoped to its own org. Exports both `GET` and `POST`. Failure-isolated per org **and** per department — one bad slice can't abort the run. No Vercel cron (Hobby rejects sub-daily); the external **GitHub Actions Schedule is the driver**, reusing the key it already holds.
- **`database/migrations/20260728010000_metrics_snapshots_rollup.sql`.** Adds `source` + `synced_at` to `metrics_snapshots`, de-dupes the pre-existing `(org, department, period)` rows (nothing had enforced one-per-period, so the org history had exact duplicates), and adds the `metrics_snapshots_org_dept_period_uniq` UNIQUE index **NULLS NOT DISTINCT** (PG15+) so the org-level `department_id IS NULL` rows collapse to one per period too — the arbiter the upsert targets. Applied live.
- **Verified against the live DB (2026-07-28, Asia/Manila):** 7 department rows + 1 org-level row written for period `2026-06-28 → 2026-07-27`; E-Commerce `gmv_impact = ₱14,086,059.19`, `quality_score = 100`, `capacity = —`. GMV reconciles **exactly** to `SUM(gmv)` over `tiktok_shop_performance` for the same window (₱14,086,059.19, 260 rows) — the org row equals the E-Commerce row equals the Command Center. Re-running left the row count at 8 (updated in place, no duplicates). Mission-control, home cockpit, OS snapshot, signals sparkline and review now resolve to the fresh `source='rollup'` snapshot instead of the stale 2026-07-12/13 rows. `INTEGRATION_PLAN.md` documents the one GitHub Actions node to add and re-affirms **GitHub Actions is not decommissioned**.
- **Standing rule:** any surface displaying GMV must reconcile to `tiktok_shop_performance` for its window, or it does not ship.

---

## [2026-07-18] — Expense module consolidation: dashboard + records + workflow + budgets + audit
- **One coherent surface under `/finance/expenses`.** Reconciles three feature branches onto main (which already had the F1 ledger) with nothing lost: **Dashboard** (`/finance/expenses`, read-only analytics), **Records** (`/finance/expenses/records`, ledger + search/filter + export + the approval workflow), **Budgets** (`/finance/expenses/budgets`), **Audit** (`/finance/expenses/audit`). One clean Finance nav set; no duplicate routes or exports.
- **Dashboard (F3, read-only).** Summary (Total / OPEX / CAPEX / VAT input / Net), Monthly Analysis (trend, cost by brand / department / category, top vendors) and KPIs (avg daily, monthly burn, period-over-period growth) over the shared `DateRangeControls`. The budget KPI reads the **F2 budget model** (count of budgets at 80 / 90 / over). Honest nulls throughout — an unknown reads `—`, never a fabricated 0; cancelled entries never count toward spend.
- **Records (F3 ⊕ F2 ⊕ F1).** Search/filter (date, code, vendor, brand, department, category, OPEX/CAPEX, allocation, payment status/method, encoder) → filtered **Excel / CSV / PDF** export (one filter parser powers the screen and every export). Encoding uses the **F1 form** (grouped categories + OR/invoice **evidence upload**); the encode route now also fires **F2 hygiene + budget alerts** and writes an immutable `expense_created` audit row. Row actions run the **F2 workflow** — Submit routes to the Approval Queue; edit/cancel are allowed only pre-submission so an in-flight `action_request` is never orphaned.
- **Immutable audit trail (F3).** Every `create / edit / approve / pay / cancel` appends an `expense_*` row to the shared append-only `action_audit` table (no update/delete policy). The approve event is written from the `advance_expense_stage` executor; the pay/edit/cancel events from the reconciled actions. CEO + COO read-only.
- **No parallel approver, no DDL.** Approvals stay on the one Action & Approval spine (F2). `net_amount` remains a **generated column** and is never written anywhere. All writes are gated to the roles RLS enforces.

---

## [2026-07-18] — Expense approval workflow + budget monitoring
- **`lib/finance/expense-workflow.ts` (new, pure).** The expense lifecycle `encoded → finance_review → department_approval → management_approval → ready_for_payment → paid → archived`. The three middle stages are **approval gates**; each is filed as a pending `action_request` (`source_module='expense'`, `source_ref={expense_id}`, `proposed_action.type='advance_expense_stage'`) through the **existing Action & Approval spine** — no parallel approver. `requiredRoleForGate` maps finance/management → `coo` (CEO + COO both see; COO owns) and department → `department_head`. `statusForStage` maps to the DB's `expenses_status_check` vocabulary; the `type`/`payment_method`/`allocation` constants mirror the live CHECK constraints so the encode form never offers a rejected value. **`net_amount` is a generated column** and is never written.
- **`lib/finance/expense-requests.ts` (new).** The one place a gate's sign-off is filed: INSERT one pending `action_requests` row + a `created` `action_audit` row + a `pending_approval` notification to exactly the roles RLS lets decide it. Shared by the `submitExpense` action (files the first gate, as the RLS user) and the executor (files the next gate on approval, as the service role) so the card, trail and notification never drift.
- **`advance_expense_stage` executor (`lib/actions/executor.ts`).** Runs ONLY after a human approves a gate. Stamps the expense one stage forward (service role — the approver, e.g. a department head, can't read/write `expenses` under RLS) and files the next gate's request until `ready_for_payment`, where it stamps `approved_by/at`. **MONEY GUARDRAIL:** it marks the expense payable but moves **no** money. A stale approval (expense already advanced) fails cleanly.
- **Money guardrail — `recordExpensePayment`.** `ready_for_payment → paid` is a HUMAN recording a payment made **outside the OS**; it only stamps `paid_at`. The Expenses UI states this in an amber banner and on the confirm dialog. The OS never executes a transfer.
- **`lib/finance/budgets.ts` + `expense-alerts.ts` (new, pure + runner).** The COO sets an annual and/or monthly budget per **brand or department** for a fiscal year. `utilized = SUM(expenses.gross_amount)` for the scope + period (cancelled expenses excluded); the UI shows remaining + %. `runBudgetAlerts` fans **80 / 90 / exceeded** notifications to CEO + COO; `checkExpenseHygiene` fires **missing-document** (blank `reference_number` — the schema has no attachment column) and **duplicate `reference_number`** alerts. All alerts reuse `notifications` + the producers, are de-duped, and are best-effort (never block the action).
- **Surfaces + RLS.** New **Expenses** (`/finance/expenses`) and **Budgets** (`/finance/budgets`) pages under HR & Finance (leadership-only), plus `expense` in the approval-card source labels. Every action is gated to the same set RLS enforces (encode = COO-only; submit/record/archive = CEO/COO; budgets = COO). A rejected gate kicks the expense back to `encoded` for correction. **Code-only — no DDL** (the `expenses`/`budgets`/`vendors`/`expense_categories` tables already exist live).

---

## [2026-07-14] — Vesper Ad Ops: gated TikTok/Meta actions via Windsor.ai
- **`lib/windsor/*` (new, server-only).** The single place the app talks to Windsor.ai. Since the deployed app can't use the Windsor MCP server (session-only), it reaches Windsor via its REST API with an org-wide `WINDSOR_API_KEY` read at **call time** (mirroring the HeyGen/fal/JSON2Video/TikTok clients) — reads via `connectors.windsor.ai/{connector}`, writes via `…/{connector}/actions`. `client.ts` throws a `WindsorNotConfiguredError` when the key is absent and a `WindsorApiError` on any non-2xx / error body (403 = write actions not enabled) so nothing is **ever** faked. `brands.ts` maps a Windsor ad account → brand from `WINDSOR_BRAND_MAP` (env JSON keyed by brand name/uuid) — **no schema change**. `actions.ts` resolves each change to the exact Windsor action id + params (verified live), honouring the per-connector budget units (TikTok major unit; Meta minor-unit cents + `budget_type`).
- **`lib/ad-ops/*` (new).** `performance.ts` reads TikTok + Meta campaign performance (spend, CPC, CTR, conversions; ROAS when a revenue field is present), requesting only Windsor-verified field ids so live pulls actually return and every absent metric stays `null` (never invented). `rules.ts` flags winners/losers using the strongest available signal (ROAS → CPA → clicks/CTR) and `draft.ts` packages a proposal as a pending `action_request` (`proposed_action.type = 'ad_action'`, `required_role='coo'`). Reuses the Action & Approval spine — **no schema change**.
- **`ad_action` executor (`lib/actions/executor.ts`).** Runs ONLY after a ceo/coo approval — the one place the OS moves ad spend. It applies the approved pause / enable / set-budget change via Windsor's write API and logs the result + before/after to `action_audit`. Any Windsor error (or an unset key) throws → the request is marked `failed` with the real message; money never "succeeds" on a failed call.
- **Producer + UI.** `app/(dashboard)/ad-ops/scan-ad-ops.ts` (ceo/coo-gated) reads live performance and drafts one gated proposal per winner/loser, idempotent per (campaign, change). New **Ad Ops** page (`/ad-ops`) surfaces real performance with honest states (a clear "ad connector not configured" panel when `WINDSOR_API_KEY` is unset, per-platform read errors surfaced inline, real empty results labelled as such — never mocked). Nav entry under Commerce Ops, an execution note on the approval card, and `/api/integrations/ad-ops/diag` (key never returned).
- **`.env.example`.** Documents `WINDSOR_API_KEY`, `WINDSOR_BRAND_MAP`, `WINDSOR_CURRENCY`, and the optional `WINDSOR_ADOPS_*` rule thresholds.

---

## [2026-07-14] — Vesper Studio: in-house auto-clipping (streams → short-form drafts)
- **New `vesper_clip_jobs` queue (migration `0023`) + out-of-runtime worker.** Vesper turns a livestream / long video into reviewable **short-form clip drafts**. Because ffmpeg and multi-minute video processing can't run in the Vercel serverless runtime, the pipeline is a **queued job model**: the app enqueues jobs and runs the Anthropic highlight-selection stage; `worker/vesper-clipper.mjs` (service-role, wherever ffmpeg is installed) does transcription + clipping and writes drafts back. See `docs/VESPER_STUDIO.md` and **D-015**.
- **Pipeline stages.** Ingest (raw `media_assets` or a URL) → transcribe (**OpenAI Whisper**, timestamped) → **segment selection (Anthropic/Claude)** picks hooks / product mentions / high-energy moments → cut vertical clips (**ffmpeg**, default 1080×1920) → draft. Clips are stored as `media_assets` in the existing **`edited`** folder (linked to the source via `metadata`); each becomes a `content_items` **draft** (`idea`) + a `short_clip` `content_assets` row with a suggested hook/caption. **Nothing auto-publishes.**
- **Zero-friction schema.** Audited the live DB first: `content_assets.kind` is plain text and `media_assets` already has a `metadata` jsonb + the `edited` folder — so the ONLY new object is the job queue. No changes to `media_assets`/`content_assets` columns or RLS; no new paid keys (reuses `OPENAI_API_KEY` + `ANTHROPIC_API_KEY`).
- **Surfaces.** New **Vesper** tab in Creative Studio (queue jobs, watch progress, review clip drafts); API routes `POST /api/vesper/ingest`, `GET /api/vesper/jobs/[id]`, `POST /api/vesper/jobs/[id]/segment` (testable in-app Anthropic step), `GET /api/vesper/diag`. `lib/vesper/*` holds the shared types, Anthropic segment selector, and job helpers.

---

## [2026-07-14] — Vesper Reach: gated outreach (email send + Viber/DM drafts)
- **`lib/outreach/vesper.ts` (new, pure).** VESPER, the outreach drafting brain. Given a client lead OR an affiliate/KOL creator plus context (brand, campaign, playbook tone) and a channel, it writes a personalized, tone-matched message and packages it as a DRAFT `action_request` (`proposed_action.type = 'send_outreach'`, born `status='pending'`). Reuses the existing Action & Approval spine and the `leads`/`creators`/`outreach_activities` tables — **no schema change**. Like every producer here it **never fabricates**: messages are built only from real fields + the context the user supplied. Includes a PH/Taglish buyer-query reply generator and an optional, fully-guarded Claude polish (`enrichMessageWithClaude`) that silently falls back to the deterministic draft when `ANTHROPIC_API_KEY` is unset or the call fails.
- **`lib/outreach/channels.ts` (new).** The single source of truth for the channel rule: **email is the ONLY auto-send channel** (`isAutoSendChannel`); **Viber and comment/DM replies are copy-paste only** (Viber ToS + no DM API), never auto-sent. Since `outreach_activities` has no channel column and we add no schema, Viber/DM log as `activity_type='message'` with a `[Viber · sent by hand]` / `[Comment/DM reply · sent by hand]` note prefix; email logs as `activity_type='email'`.
- **`lib/outreach/email.ts` (new, server-only).** The email channel. Two transports chosen by env, read at **call time**: **SMTP** (nodemailer, via `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_SECURE` + `EMAIL_FROM`) or a **provider HTTP API** (fetch, no SDK — Resend by default, any Resend-compatible endpoint via `EMAIL_API_URL`, with `EMAIL_API_KEY` + `EMAIL_FROM`). `isEmailConfigured()` / `emailConfig()` report status; `sendEmail()` throws `EmailNotConfiguredError` when nothing is set up. **Honest not-configured state** mirroring knowledge ingestion — it NEVER fakes a send and NEVER logs a mail that didn't go out.
- **`send_outreach` executor (`lib/actions/executor.ts`).** Runs ONLY after a human approval. **email** → sends via the configured provider (or fails cleanly with the not-configured error), then logs the touch to `outreach_activities` and stamps `leads`/`creators.last_contacted_at` + reschedules the next touch. **viber/dm** → sends NOTHING; approving records the human's manual send (logs the touch + stamps last-contacted). Every failure is caught and recorded as `status='failed'` with a clear message.
- **Producer + UI.** `app/(dashboard)/outreach/vesper-actions.ts` drafts a `send_outreach` request (gated to ceo/coo/department_head, matching the RLS INSERT policy) and exposes `getEmailConfigStatus()`. New **Vesper Reach** panel (`components/outreach/VesperReachPanel.tsx`) on the lead- and creator-detail pages: pick channel + tone + context (or a buyer query for a Taglish reply), draft with Vesper, preview + copy button, honest email-config warning. The Approval Queue card (`ActionCard`/`ActionDecision`) renders a channel badge, an editable draft, a **copy-to-clipboard** button for copy-paste channels, a channel-aware approve verb ("Approve & send email" vs "Mark as sent & log"), and the honest email-not-configured note.
- **`.env.example`.** Documents the `EMAIL_*` / `SMTP_*` outreach-email vars. Viber and DM need no config (copy-paste only).

---

## [2026-07-14] — Tony's READ tier: three memory sources, always cited
- **`lib/assistant/read.ts` (new).** Tony now answers from THREE retrieval sources and decides which one(s) each question needs (it may combine them), every one on the caller's **request-scoped RLS client** — so mini-Tony can never out-reach the signed-in user. **Source 1 · Live DB:** `get_org_pulse` (company-wide GMV/orders/units by marketplace + returns + headcount + project counts + pending approvals), `get_brand_status(brand)` (a brand's live status, last-60-day performance, return rate, open projects; no arg → roster), `get_department_plan(department)` (latest snapshot metrics + narrative plan + lead; no arg → list), `list_my_work()` (the caller's OWN open tasks + owned projects), and `get_finance_snapshot()` (company P&L). **Source 2 · Knowledge (RAG):** `search_knowledge(query)` → `searchKnowledge()`, returning citable document excerpts. **Source 3 · Memory:** `recall_memory(query|category)` reads durable facts from `public.tony_memory`.
- **Finance is omitted, not just blocked.** `buildReadTools(role)` includes `get_finance_snapshot` only for ceo/coo, so a non-leadership mini-Tony is never even told it exists; the executor also guards internally and RLS remains the hard wall (belt-and-suspenders, mirroring the existing finance gate).
- **Grounded + cited contract (`buildReadPrompt`).** Every fact is prefixed with its origin — "From live data …", "From the &lt;document title&gt; …", or "From memory …". **Numbers come ONLY from the live database** (a document figure is "as documented", never quoted as current); empty retrieval yields "I don't have that yet" — never a fabricated answer.
- **`lib/knowledge/search.ts` (new, Brief A).** `searchKnowledge()` retrieves citable chunks from the `documents` Knowledge Base over the caller's RLS client (keyword ranking over title/`extracted_text`, returning the source title + a snapped text window). Degrades to `[]` on any error — including the table not existing yet — so the assistant says "not documented yet" instead of erroring; the semantic (pgvector) ranker can slot in behind the same signature later.
- **`database/migrations/0021_knowledge_documents.sql` (new).** Provisions `documents` + `document_tags` with org-scoped RLS (read/insert/update for members, delete leadership-only), a guarded pg_trgm index, and a pgvector `embedding` column added only when the extension is present — so it applies cleanly pre-pgvector. Idempotent.
- **`/api/assistant` + `lib/assistant/tools.ts`.** The READ tier is registered on the **existing** tool-use loop alongside `navigate` + act (no new assistant, no new UI, no new tables beyond the knowledge base). The six legacy read tools the READ tier subsumes (`get_kpi_summary`, `get_brand_performance`, `get_department_metrics`, `get_finance_summary`, `get_headcount`, `list_tony_memory`) were **retired** to keep the tool set coherent; the complementary reads (`list_brands`, `list_departments`, `get_returns_analysis`, `get_payroll_summary`, `get_pending_approvals`, `list_projects`) remain, and shared helpers now live in one place.

---

## [2026-07-14] — E-Commerce: auto-populate the brand view + per-brand commerce dashboard
- **`lib/metrics/tiktok-live.ts` (new, read-only).** The live per-brand commerce reader. It reads the ALREADY-SYNCED landing tables directly — `tiktok_shop_performance` (daily GMV / orders / units / visitors / page_views / conversion_rate) and `tiktok_settlements` (net payout + refunds + gross) — through the ordinary **RLS org-scoped** server client (both tables carry an `org_id = current_org_id()` select policy). No service role, no writes, and it **never triggers a TikTok backfill**, so the audited historical GMV is untouched. A brand can span multiple shops, so additive fields are summed per (brand, day) and conversion is DERIVED as orders ÷ visitors (never an average of rates); an unreported metric stays `null` → the UI shows "—", never a fabricated 0. Exposes `getBrandLiveDays`, `getLiveLatestByBrand`, `getBrandSettlement`, `getSettlementByBrand`, and a `fmtStatDate` helper for the "as of &lt;stat_date&gt;" stamp.
- **`/brands/[id]` — per-brand Commerce dashboard (new route).** What "opening a brand" now lands on. The **Live TikTok Shop** header auto-populates GMV / orders / units / visitors / conversion from the latest synced day and stamps "as of &lt;stat_date&gt; · source" — nobody types the numbers. Below it: a **settlements** roll-up (net payout / refunds / gross / statements), then the commerce dashboard — GMV trend sparkline (from the live daily series), orders/units, **return rate** and **ROAS** read from `brand_platform_metrics` through the shared `aggregate()` (so the windowed figures reconcile with the Command Center / Platforms for the same window), plus the existing **`<AiBrief scope="account">`** block. Honest empty states throughout (single synced day → "trend draws once a second day lands"; no ad spend → "ROAS shows once ad data lands").
- **`/brands` — Brand Portfolio auto-metrics.** Each brand card now leads with the same live **auto** TikTok Shop strip (latest synced day, "as of" stamp), so the portfolio fills itself in from live data. The manual Sales/Traffic-source and initiative forms remain **as an override/fallback only**. Client names and a per-card "Open dashboard →" link route to `/brands/[id]`.
- **`/accounts` — truthful sync note.** Replaced the hard-coded "Marketplace sync is not yet connected" line with one driven by the computed truthfulness badge: a live-synced brand reads "auto-populated from the live TikTok Shop sync — no manual entry needed", and links to the new commerce dashboard.
- **No schema change** — every table reused as-is; the daily read-sync + reconcile that already populate the data are left exactly as they are.

---

## [2026-07-13] — Opportunity Engine, usable by hand (no paid lead source)
- **`automation_registry` (existing production table).** The org-scoped `key → webhook_url` registry already lives in the DB with a live, enabled `opportunity_engine` row, so integration endpoints are **data, not constants**: the Opportunity Engine panel reads its webhook from here at call time and it can be rotated / repointed at a staging GitHub Actions with no code change. RLS mirrors the OS — any member reads, only ceo/coo write. No new migration is added; the app code simply reads the row that's already there.
- **`lib/opportunities/`** — the engine's app-side spine, all dependency-light and unit-verified: `csv.ts` parses a pasted/uploaded prospect list (`name, category, monthly_revenue, sells_online, has_tiktok_shop, gmv_declining, runs_ads`; reordered/partial headers, quoted commas, `45k`/`2m` revenue, and tri-state yes/no/blank signals — a blank is `null`, never fabricated); `engine.ts` owns the `{ criteria, candidates }` POST + a defensive normalizer that accepts several response shapes and coerces tier→HOT/WARM/COLD and score→0..100; `registry.ts` resolves the webhook (missing / disabled / placeholder → an explicit not-ready reason); `gateway.ts` **stages the HOT results as pending `action_requests`** for approval, idempotent (skips a prospect already open or one the engine's own gateway staged).
- **`/leads` — "Find Opportunities" panel.** Paste or upload a list, set optional ranking criteria (focus category, min revenue, which signals to prioritize), and the engine ranks it. Results render inline with tier + score + reason; HOT ones link straight to the approval queue. `findOpportunities` server action gates to ceo/coo/department_head (the roles RLS lets stage), reads the webhook from the registry (never a constant), and returns calm, specific messages when the engine isn't configured or is unreachable.
- **Executor — `create_opportunity_task`.** On approval the OS opens ONE internal BizDev qualification task (assignee = the BizDev/Sales head, else the approver) carrying the engine's tier/score/reason. **Nothing reaches a prospect** — it only stages the research decision for a human, consistent with D-005.

---

## [2026-07-13] — Tony can navigate (Phase 2, Step A): `navigate` tool
- **`lib/assistant/routes.ts`** — a **Route Registry** of the app's real, navigable pages, each with a plain-language description (plus the note that "take me to `<brand>`" targets `/brands` and a department targets `/departments`, since there is no id-less per-brand/department page). Exposes `routesForRole()` (strips leadership-only pages — Finance, Payroll, the Executive view, AI Platform — for anyone who isn't ceo/coo), `NAVIGATE_TOOL` (the Anthropic tool def), `resolveNavigation()` (validates a model-supplied path against the role's registry and returns the **canonical** `{ path, label }`, or null), and `buildNavigationPrompt()`.
- **`/api/assistant` route** — extended the existing grounded tool-use loop (no new assistant/UI/tables) with the one `navigate` tool. The role-filtered registry is appended to the system prompt, so the model is only ever told about pages it can reach. On a valid `navigate` call the loop short-circuits, returns `{ navigation: { path, label } }` to the client, and posts "Taking you to X →"; an off-list/invented path is refused (`ok:false`) so Tony says there's no such page instead of navigating. Personality, history, memory, and grounding are unchanged.
- **Clients** — `AssistantChat` (typed) and `useTonyVoice` (voice) both `router.push(navigation.path)` when the reply carries a navigation. Because every surface calls the same `/api/assistant` with the caller's session role, the leadership-only filter is enforced in exactly one place — a team member's Tony (and any future Mini-Tony) is never offered Finance; a CEO's is.
- **Safety:** `navigate` only changes the page shown — it reads nothing, writes nothing, and needs no approval.

---

## [2026-07-08] — AI model governance (D-012): tiered models + per-task grants
- **Migration `0016` — model governance.** New `model_tier` enum (`lite`/`standard`/`premium`), `model_grants` table (single-use, per-task, with optional `expires_at`), and a `model` column on `ai_messages` for cost visibility. RLS: a user sees only their own grants (ceo/coo see all); **only ceo/coo can insert** a grant; the grantee marks their own grant used. Extended `decide_approval()` to execute `model_access` requests — on approval it mints one single-use grant of the requested tier for the requester, and a hard guard blocks anyone but ceo/coo from deciding a `model_access` request (tighter than the general reviewer set, which includes department heads). Applied to live and committed together (no drift).
- **`lib/ai/models.ts`** — single source of truth for the tier→model map: `lite`→`claude-haiku-4-5`, `standard`→`claude-sonnet-5`, `premium`→`claude-opus-4-8` (IDs confirmed against the Anthropic docs). Role defaults: team→lite, dept head→standard, ceo/coo→premium. Dependency-free so both the server route and the client UI share it.
- **`/api/assistant` route** — replaced the hard-coded `MODEL` with tier enforcement: the effective tier is the caller's role default, or a higher tier **only** if a live single-use grant covers it. Above-ceiling with no grant returns `403 { needsApproval, requestedTier }`. The grant is consumed **only after** the Claude call succeeds (a `used_at is null` guard keeps it idempotent), so a failed request never burns it. The answering model is written onto the `ai_messages` row.
- **Assistant UI** — a model picker in the chat header (tiers above the caller's default are labelled "needs approval"); an inline **Request access** flow (`RequestModelAccessForm`) appears when the route says a tier needs approval, filing a `model_access` request into the existing approval queue. Assistant bubbles show which tier answered, and the approvals queue shows the requester's reason so ceo/coo can decide with context.
- **Governance model:** maximum control — every above-default use is one CEO/COO approval, one task, one grant. No standing elevated access.

---

## [2026-07-08] — Command Center v1 + tech-debt cleanup
- **Command Center v1** (`/ceo`): evolved the CEO page into the premium "digital HQ". The universal metric set (GMV impact, efficiency, quality, capacity) renders as hero tiles with week-over-week movement; departments show live per-department efficiency (⚠ flag under 75%); the brand portfolio highlights the lead brand; and a new cross-channel **platform strip** surfaces GMV / orders / ad spend / blended ROAS from `brand_platform_metrics` with a link to `/platforms` (empty state until data flows). Role-guarded to ceo/coo; built on the existing tokens + AppShell/StatCard (added `MetricTile`).
- **Regenerated `types/database.ts`** from live (adds `brand_platform_metrics`, `brands.category`, the `risk_tier`/`platform_channel` enums, `decide_approval`), preserving the hand-added aliases and adding `BrandRow`/`BrandPlatformMetricsRow`/`PlatformChannel`/`RiskTier`. Dropped every `as never` cast — the approvals RPC and the platforms page/import are now fully type-checked.
- **Hardened the secret-scan CI**: swapped the license-gated gitleaks-action (which errored at setup) for the gitleaks OSS binary via Docker, scanning the working tree so the public, env-only Supabase anon key never false-flags.

---

## [2026-07-08] — Platform data unification (part 1: foundation + manual import)
- **Migration `0015` — `brand_platform_metrics`**: per-brand × platform × period facts (GMV, orders, units, returns, fulfillment_errors, ad_spend, ad_revenue, roas), org-scoped RLS, manager-only writes, `source` distinguishes manual import from Windsor auto-sync. Applied to live and committed together (no drift).
- **`/platforms` page**: brand × platform performance table + org rollup (Total GMV, orders, ad spend, blended ROAS), with a manager-only bulk paste-import of the canonical template (`templates/brand_platform_import_template.csv`). Added **Platforms** to the app nav.
- **Data pipeline plan** (`docs/INTEGRATION_PLAN.md`): Windsor.ai coverage verified live — Meta Ads already connected, and `tiktok_shop` / `tiktok` / `google_ads` connectors available (Shopee has none → manual template). Reframed "integration" as a data pipeline (Track A manual for Shopee, Track B auto for the rest). Shopify-as-a-Shopee-bridge evaluated and dropped (no Shopify in use); Shopee automation target is the Shopee Official Partner API.
- **DECISIONS D-012**: tiered AI model access — Haiku (team) / Sonnet (dept heads) / Opus (CEO/COO), premium use gated per-task through the approval queue.

---

## [2026-07-07] — Sprint 0: Safe & Sharp (security hardening)
- **INC-2026-002 — tamper-proof audit logging.** The audit trail was wired but weak: the browser inserted the audit row directly, so `actor_id` was forgeable, the write was silent/unverified, and only approval decisions were covered. Replaced with a `SECURITY DEFINER` trigger (`audit_privileged_change`, migration `0011`) recording approval decisions **and** user role changes, actor forced to `auth.uid()`. Dropped the client `audit_logs` insert policy (audit rows can't be forged/altered/deleted via the API) and revoked the trigger function's RPC grant from `anon`/`authenticated` (`0011`/`0013`). Proven against the live DB in `database/tests/audit_verification.sql` (DECISIONS D-011).
- **Atomic approval decisions.** Added `decide_approval()` (migration `0014`) — one `SECURITY INVOKER`, RLS-enforced transaction that validates the reviewer role, executes the proposed action, records the decision, and lets the audit trigger fire. Rewired `ApprovalActions.tsx` to call only this RPC (`requestId`/`decision`/`note`); `approvals/page.tsx` passes only `requestId`. The client no longer writes to `tasks`/`approval_requests`/`audit_logs`.
- **Schema:** migration `0012` — `brands.category` (nullable) and `approval_requests.risk_tier` (enum LOW/MED/HIGH/CRIT, default MED).
- **P0 secret-scanning:** `SECURITY.md`, gitleaks CI (`.github/workflows/ci-security.yml`), and `.gitleaks.toml` — every push/PR now fails on a leaked secret (BUGS R-003).
- **Supabase security advisor:** clean except the 2 intentional RLS-helper warnings (D-009) and leaked-password protection (R-010, one-click dashboard toggle — still pending).
- **Reconciled repo↔live drift:** migrations `0011`–`0014` had been applied to the live DB but never committed (a prior session reported a push that never landed). Reconstructed byte-accurate from the Supabase migration ledger and committed so `database/migrations/` matches live exactly. Guard for next time: verify the branch on GitHub after migration work — don't trust a session's "pushed" claim.
- **Known follow-up:** `types/database.ts` not yet regenerated for `decide_approval` (RPC call cast `as never` until then) — see TODO.

---

## [2026-07-07] — Post-MVP fixes: performance, assistant activation, security incident
- **Performance:** functions were running in `iad1` (US East) while the DB is in Tokyo and users are in the Philippines — every page's DB queries crossed the Pacific. Pinned `regions: ["hnd1"]` in `vercel.json` (DECISIONS D-010); app is now snappy.
- **AI assistant activated:** the "not configured" error was `ANTHROPIC_API_KEY` resolving to an empty string at runtime. Root-caused with a temporary diagnostic (Vercel runtime env injection works — `VERCEL_*` vars present — so the stored value was blank; the value simply hadn't saved). Fixed by minting a fresh key and re-saving it non-sensitive. Verified live (key length 108, assistant responds).
- **⚠️ Security incident (self-inflicted, remediated same-hour):** the diagnostic endpoint was expanded to print the raw key value and was publicly reachable, exposing the key for ~2 minutes. Remediation: endpoint + middleware bypass removed immediately (verified `/api/debug-env` now 404s to login), and the exposed key was **revoked and rotated**. Lesson: never log/return a secret's value, even in a temporary diagnostic — presence + length only. (`.gitignore` already prevented any key from entering the repo.)

---

## [2026-07-07] — Milestone 8: Testing & Hardening
- **Live RLS penetration test** (`database/tests/rls_verification.sql`): provisioned a throwaway `team_member`, executed queries in that user's security context (JWT `sub` + `authenticated` role), and proved — against the real DB — that audit logs are hidden (CEO/COO only), another user's AI messages are isolated, and approve/metrics writes are rejected (`42501`), while org-wide reads still work. All pass; test artifacts cleaned up.
- **R-008 resolved**: `next` pin `14.2.5` → `^14.2.5` so the build installs the latest patched 14.2.x (clears the security-update deprecation).
- **Migration 0010**: tightened task/project delete to creator-or-admin (R-005 hardening); reads/edits stay org-wide for MVP.
- Updated BUGS.md: R-001 mitigated (RLS verified), R-005 partially addressed, R-008 resolved, added R-010 (leaked-password protection — a one-click dashboard setting for the user), and a Resolved section.

---

## [2026-07-07] — Milestone 7: Reports v1 (+ repo migration sync)
- Migration `0009`: `metrics_snapshots` (the universal metric set — GMV Impact, Efficiency, Quality, Capacity, per department/period) and `reports` (stored jsonb rollups). Metric entry restricted to ceo/coo/department_head.
- **`/reports`**: org rollup cards, per-department latest-metrics table, manager metric-entry form, one-click **"Generate weekly report"** (deterministic 7-day rollup stored as a report), and expandable generated-report views.
- **Lit up the dashboards**: CEO command center now shows Total GMV impact / avg Efficiency / Quality / Capacity; department dashboards show their latest Efficiency / Quality / Capacity — replacing the "—" placeholders with live data.
- Seeded a week of metrics across all 7 departments.
- **Fixed R-007 drift**: migrations `0005`–`0009` had been applied to the live DB via the connector but weren't in the repo — wrote all five `.sql` files so `database/migrations/` now matches the live schema exactly.

---

## [2026-07-07] — Milestone 6: Approvals v1
- Migration `0008`: `approval_requests` (status enum, payload jsonb, reviewer + timestamp) and `audit_logs`. RLS: org can see/propose; only ceo/coo/department_head can decide; audit readable by ceo/coo only. Advisor clean.
- **`/approvals`**: pending queue, "Propose a task" form (stands in for AI task-generation until V1.5), recent-decisions history, and an audit trail for CEO/COO.
- **Executes on approve**: approving a `create_task` proposal creates the real task, then records the decision and writes an `audit_logs` entry — the full D-005 loop (propose → approve → execute → log) working end to end for the first time.
- Seeded 2 sample AI proposals so the queue is populated; added **Approvals** to the app nav.

---

## [2026-07-07] — Milestone 5: AI Assistant v1
- Migration `0007`: `ai_conversations` + `ai_messages` with **user-scoped** RLS (a user only ever sees their own chats). `0008` was folded in — no extra migration needed. Advisor clean (only the 2 intentional RLS-helper warnings).
- **`/api/assistant` route** (Node runtime): authenticates via Supabase, persists the user message, calls the **Anthropic Messages API** (`claude-opus-4-8`) server-side via `fetch` (key in `ANTHROPIC_API_KEY`, never client-exposed), persists the reply. Guardrails: 100 messages/user/day, 4000-char input cap, graceful "not configured" error if the key is unset.
- **`/assistant` chat UI**: real conversation thread that persists across visits (loads the latest conversation server-side), Enter-to-send, "New chat", and a recommend-only banner per D-005.
- Deliberately used raw `fetch` over the Anthropic SDK to avoid adding an npm dependency whose exact version couldn't be verified to resolve on Vercel — the REST contract (`anthropic-version: 2023-06-01`) is stable.
- **Requires** `ANTHROPIC_API_KEY` in Vercel to actually talk to Claude (logged in TODO). Chose recommend-only scope: the assistant never writes to production data (D-005).

---

## [2026-07-07] — Milestone 3: Task Management
- Migration `0005`: `projects`, `tasks` (self-referential subtasks via `parent_task_id`), `task_comments`, `task_attachments` — org-scoped RLS, indexes, `updated_at` triggers, `created_by`/`status` on every table
- Migration `0006`: revoked RPC exposure on the `handle_new_user` trigger function (advisor 0028/0029)
- Regenerated `types/database.ts` from the live schema (now includes task tables + `TaskStatus`/`TaskPriority`/`ProjectStatus` and row aliases)
- **`/tasks` board**: live task table (title, project, assignee, brand tag, priority, due date, status pill) with inline **New task** and **New project** forms — all writes go through the browser client and are RLS-guarded
- **`/tasks/[id]` detail**: status/priority/assignee controls, subtasks (add inline), comments (add + list), brand/project/due-date sidebar
- Added shared display helpers (`lib/tasks/display.ts`) and wired **Dashboard**/**Tasks** nav into the AppShell
- Seeded 1 sample project ("Q3 GMV Push — FML") + 5 tasks so the board is populated on first login
- Milestone 3 covers create/assign/status/subtasks/comments/brand-tagging. Deferred: file attachments (needs a Storage bucket), Kanban view, finer write RBAC — logged in TODO.

---

## [2026-07-06] — First Vercel deployment: connected repo + fixed the build chain
- Pushed the repo to GitHub (`albertjhonmorales-spec/mthryve-os-private`, branch `main`) and connected it to Vercel project **mthryve-os** (team MTHRYVE OS); every push to `main` now builds
- Worked the build red→green through several real failures surfaced by the cloud build:
  1. **No Next.js detected** — the app was nested at `repo/app/`, needing a Root Directory override that wasn't sticking. Moved the Next.js app to the repo root (matches PROJECT.md §6) so default settings build it.
  2. **`never`-typed query results** — the `@supabase/ssr` typed client resolved `.select()` rows to `never`. Regenerated `types/database.ts` from the live schema, then typed each query result explicitly (CEO/department/employee + session) so the build no longer depends on that fragile inference.
- Logged two build-surfaced issues in BUGS: R-008 (Next.js 14.2.5 security-update due) and R-009 (Supabase pulls a Node API into Edge middleware — warning only)
- Added `.gitattributes` (LF normalization) and cleaned up duplicate Vercel projects

---

## [2026-07-06] — Milestone 1–2: role-based routing + live dashboards
- Added `lib/auth/session.ts` — the single source of "who is this and what can they see": `getSessionProfile`, `requireProfile`, `requireRole`, and `homeRouteFor` (one canonical home route per role)
- Root `/` is now a real role dispatcher: CEO/COO → `/ceo`, Department Head → `/department/[their-id]`, Team Member → `/employee` (replaced the hardcoded `/employee` redirect)
- Built three dashboards, all reading **live seed data** from Supabase (verified data shape via live query):
  - `/ceo` — command center: department count, active/total brands, lead-brand GMV, plus live department and brand-portfolio lists (role-gated to ceo/coo)
  - `/department/[id]` — department workspace with team-member count; RBAC-scoped (dept heads locked to their own department, team members redirected out, 404 on cross-org ids via RLS)
  - `/employee` — personal workspace resolving the signed-in identity + department
- Added `/assistant` placeholder so the "Ask the assistant" entry point in every page resolves instead of 404-ing (real assistant is Milestone 5)
- `AppShell` now renders the signed-in user (name, role, initials) and a working **Sign out** control (`SignOutButton` client island)
- Added `components/ui/StatCard` primitive (mono-face metric cards on the design tokens)
- Verified statically (import graph + cross-file contracts). Runtime/UI verification happens on the first Vercel build/deploy.

---

## [2026-07-06] — Backend goes live (real Supabase infra connected)
- Restored and adopted the existing Supabase project `otepdjhrawtqkzclaxbk` (region ap-northeast-1 / Tokyo) as the Mthryve OS backend — no new billable project created
- Applied `0001_init_schema` to the live database: 5 tables, 11 RLS policies, helper functions, triggers, and the real Mthryve seed (1 tenant, 1 org, 7 departments, 10 brands — 9 active + Star 360 inactive). Verified via row counts.
- Ran the Supabase security advisor and hardened the schema:
  - `0002_harden_functions`: pinned `search_path = ''` and fully-qualified refs on all `SECURITY DEFINER` functions; revoked anon/public RPC access on RLS helpers (kept `authenticated`)
  - `0003_revoke_trigger_fn_rpc`: removed all RPC grants from the `set_updated_at` trigger function
  - Advisor now reports only 2 intentional warnings (RLS helpers must be `authenticated`-executable) — logged as DECISIONS.md D-009
- Wired the frontend to the live backend via gitignored `app/.env.local` (real project URL + public anon key; service-role and Anthropic keys left blank until their milestones)
- Moved the project to a clean home (`C:\Users\dadap\mthryve-os`), initialized git, and added the previously-missing `.gitignore` (protects `.env*.local` per D-006)
- `0004_user_provisioning`: added a `handle_new_user` trigger on `auth.users` that auto-creates the matching `public.users` profile (org/name/role from invite metadata), plus a `users_insert_self` RLS policy. **Verified live**: creating a test auth user provisioned a `ceo` profile in the Mthryve org; deleting it cascade-removed the profile.
- **Verified at the data layer** (live SQL queries confirm schema, seed, and the signup trigger). **Not yet verified in a browser** — Node.js is not installed on this machine, so `next dev` can't run locally; a Vercel deploy (cloud build) or a local Node install is the way to see it running.

---

## [2026-07-06] — Milestone 0 (Foundation) scaffolded
- Scaffolded Next.js App Router project: `package.json`, `tsconfig.json`, `next.config.mjs`, Tailwind config with the charcoal/teal/green/gold dark theme tokens
- Built `0001_init_schema.sql`: `tenants`, `organizations`, `departments`, `brands`, `users` tables, RLS policies scoped via `current_org_id()`/`current_user_role()` helper functions, `updated_at` triggers, and a seed block for the real 7-department / 10-brand Mthryve structure
- Built Supabase browser + server clients (`lib/supabase/`) and session-refresh middleware
- Built login page (invite-only, no public sign-up) and a placeholder employee dashboard behind the shared `AppShell` (breadcrumb, search, notifications, AI assistant entry, profile)
- Added `.env.example` and project `README.md` with setup instructions
- Not yet done: no real Supabase/Vercel/GitHub project connected — this is code only, ready to be wired to real infra

---

## [2026-07-05] — Architecture & planning docs established
- Created `PROJECT.md`: product vision, two-path (artifact vs. production) architecture analysis and recommendation, full Path B database schema, folder structure
- Created `ROADMAP.md`: MVP → V1.5 → V2 → V3 milestones with exit criteria
- Created `DECISIONS.md`: 8 initial architectural decisions logged (D-001 through D-008)
- Created `TODO.md`: full MVP backlog, grouped by milestone
- Created `BUGS.md`: 7 pre-launch risks identified and logged (R-001 through R-007)
- Created `AI_AGENTS.md`: specifications for company assistant + 3 forward-looking agents
- No application code written yet — this entry marks the end of the planning phase, not the start of the build phase

---

## Prior work (pre-dates this changelog, summarized for continuity)

### June–July 2026 — Artifact-based Mthryve OS V3 (Path A)
- Built Department Command Center, Deep Search, Creator/Affiliate Portal, Supplier Portal, and Distributor Network Dashboard as React artifacts sharing a `window.storage` layer
- Integrated real audit data (`AUDIT_ALL_BRANDS.xlsx`), confirming full 10-brand roster and real monthly team costs
- Locked in universal metric set (GMV Impact, Efficiency, Quality Score, Capacity Utilization) across 7 departments
- Completed live compliance review of Distributor Dashboard against DTI/SEC/FDA MLM regulations (4/5 checks passed, 1 conditional)
- Identified Zapier as integration bridge for TikTok Shop/Shopee/Lazada/Meta; Shopify flagged as having a native connector

### Late June 2026 — Earlier prototype + AI enablement program
- Built single-file HTML prototype: role-based dashboards, Smart Agent AI co-pilots, Kanban, RACI matrix, integrations hub, messaging, news, leaderboards
- Scoped multi-file deliverable set (Excel workbook, PowerPoint, PDF command centers)
- Designed and delivered 30-day AI mastery program for the Mthryve team (C.O.R.E. prompt framework, agent creation, automation roadmap)
