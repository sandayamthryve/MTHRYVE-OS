# Mthryve OS — AI_AGENTS.md

Specification for every AI agent in the system. The master brief specifies **one company assistant** for MVP — this doc defines that agent's functions precisely, plus documents the future agents implied by the roadmap so they're designed intentionally rather than bolted on later.

**Governing rule for every agent below (see `DECISIONS.md` D-005): analyze → recommend → human approves → execute → monitor → report. No agent writes to production data without an approval step, ever, at this stage.**

---

## Agent 1: Company Assistant (MVP)

**Status:** MVP scope
**Access:** All authenticated users, scoped by their own role/department permissions

**Functions:**
| Function | MVP? | Description |
|---|---|---|
| Chat | Yes | General-purpose conversation, company-context-aware |
| Company Knowledge Search | Yes | Retrieves from `documents` table (Knowledge Base) |
| Document Search | Yes | Same underlying retrieval as above, exposed as a distinct entry point in UI |
| Meeting Summary | V1.5 | Takes transcript/recording → structured summary + action items |
| Report Generation | V1.5 | Drafts a report from `metrics_snapshots`, routed through Approvals before distribution |
| Strategy Suggestions | V1.5 | Recommendations only — never auto-implemented |
| Task Generation | V1.5 | Drafts tasks from a prompt or meeting note → lands in `approval_requests`, not directly in `tasks` |

**Tools available to this agent:** knowledge base search, read-only metrics query, (V1.5+) task draft creation, report draft creation.

**READ tier — three memory sources, always cited (see `DECISIONS.md` D-014).** Retrieval is organized as one READ tier over three sources, all on the caller's RLS-scoped client, and Tony cites which one each fact came from:
- **Live database** (the only source of numbers): `get_org_pulse`, `get_brand_status(brand)`, `get_department_plan(department)`, `list_my_work()`, `get_finance_snapshot()` (leadership only — omitted from a non-leadership mini-Tony's tool list, not merely blocked).
- **Knowledge base / RAG**: `search_knowledge(query)` → `searchKnowledge()` over uploaded documents, returning citable excerpts with their source document title.
- **Memory**: `recall_memory(query|category)` over durable facts in `tony_memory`.

Rules are structural: every fact is prefixed with its origin ("From live data …" / "From the &lt;doc title&gt; …" / "From memory …"); empty retrieval yields "I don't have that yet" (never fabricated); a document/memory figure is never quoted as a live number.

**Act tiers (Phase 2, Step C — see `DECISIONS.md` D-013).** The assistant ("Tony") can now *act*, in two tiers, always on the caller's own RLS-scoped client:
- **Direct** — low-risk, self-scoped writes the signed-in user could already make: `update_my_task_status` (own task), `add_content_item` (owned piece), `pin_memory_note`. Done on their behalf and confirmed in one line.
- **Proposed** — consequential actions become a **pending `action_requests`** row in the Approval Queue via `propose_action`; a human approves and the existing executor runs it. Tony never executes consequential actions itself.

**Two-tier identity.** Full **"Tony"** is the CEO's assistant only (full tools, finance reach, cross-department, highest act tier). Everyone else gets **"mini-Tony"**: same engine, role-filtered tools, RLS-walled data, act tier scaled by role — a `team_member`'s mini-Tony is direct-only and routes anything bigger to its department head (RLS `ar_insert` blocks it from filing approvals).

**Money is never executable, and nothing is sent externally.** Finance proposals are recommendation-only `action_requests` (no executor); "follow-ups" stage internal drafts (SMTP deferred). **Still no direct write access to `distributors`, `suppliers`, or financial tables** — those go through `action_requests`, and money never gets an executor.

**Guardrails:**
- Every response involving a recommendation is visually distinguished from a fact/retrieval in the UI (e.g. "Suggested" badge)
- Conversation history stored per-user (`ai_conversations`/`ai_messages`) for audit and continuity
- Rate limiting per user per day (specific threshold TBD once real usage data exists — start conservative, loosen based on data)

---

## Agent 1b: Vesper — Operator (Growth Pods)

**Status:** V1 (internal, auto-run tools only)
**Access:** All authenticated users can chat + preview the scoreboard; filing plays is leadership-only (ceo/coo/department_head, mirroring `action_requests` RLS).

Vesper is a **second assistant persona** on the same agentic tool-loop as Tony
(`/api/vesper` mirrors `/api/assistant`; tools live in `lib/vesper/`). The split
mirrors the approval spine: **Tony PLANS** (recommends, proposes); **Vesper
EXECUTES** (turns a decision into a filed play, then reports what ran). Vesper
never executes anything itself — it files a **pending `action_request`**
(`source_module='tony_plan'`, `proposed_action.type` = one of its six executor
types); a human approves and the SAME executor (`lib/actions/executor.ts`,
the create_lead spine) runs it and writes an `action_audit` row.

**Six internal executors** (all auto, internal-only — no outbound, no spend, no
new keys), each reusing existing infra:
| Play | Reuses | Effect |
|---|---|---|
| `generate_scripts` | Content engine (`lib/content`) | Stage script-brief content ideas per SKU × pillar × format |
| `forecast_restock` | Warehouse velocity engine (`lib/warehouse`) | Restock signals + suggested qty |
| `next_best_product` | `live_sessions` + TikTok Shop readers | Rank products to push next |
| `match_creators` | `creators` + `creator_tiers` | Rank creators for a brand/campaign |
| `analyze_content_performance` | `content_performance` | What converts by format/platform |
| `compile_scoreboard` | GMV engine + `pods` (`lib/vesper/scoreboard`) | Assemble the Growth Scoreboard |

**Guardrails:** the one writer (`generate_scripts`) only stages reversible
internal `content_items`; the rest are reads. Approval is the default gate —
low-risk read-only plays MAY be configured to auto-run (`AUTO_RUN_LOW_RISK`,
default OFF), and even then they still file + flow through the executor with a
full audit trail. Money is never an executable action; nothing leaves the
building.

**Growth Pods + Scoreboard:** `pods` / `pod_brands` (leadership-gated RLS) model
the operating teams; the **Growth Scoreboard** (`/scoreboard`) is Tony's weekly
cockpit — brands under management, GMV managed, live ROAS, pod contribution %
(where cost data exists, else "—"), retention/churn, and concentration risk —
computed per pod and org-wide from live data, with honest em-dashes for anything
not yet measurable.

---

## Agent 2: Deep Search — Competitor Intelligence (currently artifact-based)

**Status:** Exists today as a Path A artifact; candidate for later promotion to a full module (V3, per `ROADMAP.md`)
**Access:** BD Lead, Creative, CEO

**Functions:** competitor tracking, market intelligence retrieval, comparison reporting.

**Design note:** Read-heavy, low-stakes (no writes to core business data), which is why it's a good candidate to stay artifact-based longer than other modules — the cost of migrating it early is higher than the risk of leaving it as-is.

---

## Agent 3: Approval Routing Agent (V1.5)

**Status:** Planned, not built
**Purpose:** Not a conversational agent — a background process that takes any AI-proposed action (from Agent 1) and routes it to the correct approver based on department/action type, then triggers execution only after approval, then reports back to the requester.

**Functions:** route proposal → correct approver, notify approver, execute on approval, log to `audit_logs`, notify requester of outcome.

**Why separate from Agent 1:** keeps the conversational assistant's responsibilities (recommend) cleanly separated from the workflow engine's responsibilities (route, execute, log) — makes the "no autonomous critical actions" rule enforceable in code, not just in prompt instructions.

---

## Agent 4: Integration Monitor (V2)

**Status:** Planned, not built
**Purpose:** Watches incoming data from TikTok Shop / Shopee / Lazada / Meta (via Zapier) and GitHub Actions workflows, flags anomalies (e.g. a sudden fulfillment error spike on a brand), and drafts an alert for human review — does not act on the anomaly itself.

**Functions:** anomaly detection on ingested metrics, draft alert generation → routed through Approval Routing Agent for distribution.

---

## Agent 5: Care — Wellbeing & People Care (V1)

**Status:** V1 — live (internal, HR & Admin)
**Access:** All authenticated users can chat + log own pulse; team aggregates + probation care context are HR/leadership only (`canManageProbation`); filing check-ins is `ceo/coo/department_head` (mirrors `action_requests` RLS).

Care is the wellbeing agent for People. She is warm, concise, confidential — never invents, never exposes another person's raw mood. She runs on the same agentic loop as Tony/Vesper (`/api/care` mirrors `/api/assistant`; tools live in `lib/care/`). Reads are RLS-scoped; the only direct write is self-only `log_wellbeing_pulse` (one `wellbeing_pulses` row per user per day, upsert). Consequential acts file a **pending `action_request`** (`proposed_action.type='care_check_in'`); a human approves and `lib/actions/executor.ts:care_check_in` completes the `care_check_ins` ledger. Nothing is sent externally, no money moves.

**Tools**
| Tool | Tier | Effect |
|---|---|---|
| `get_my_care_summary` | read | Self: probation status, 14d attendance, recent pulses |
| `get_team_care_pulse` | read | Aggregated: anonymized 14d mood avg + count, probation queue depth, attendance late (HR only) |
| `get_probation_care_context` | read | One probationary hire: days left, review-due, 14d attendance (HR only) |
| `search_hr_knowledge` | read | RAG over HR docs, citable |
| `log_wellbeing_pulse` | direct | Self upsert mood 1-5 + optional note into `wellbeing_pulses` |
| `propose_check_in` | proposed | File pending `care_check_in` check-in for HR to approve |

**Guardrails:** raw mood is self-only; team pulse is anonymized avg+count; probation care respects `canManageProbation`; all facts cited; empty → "I don't have that yet"; executor `care_check_in` only marks ledger completed.

---

## Agent 6: Atlas — Knowledge Graph (V1)

**Status:** V1 — live
**Access:** All authenticated users (reads), filing captures is `ceo/coo/department_head`.

Atlas maps what Mthryve knows. He runs on the same loop as Care (`/api/atlas` mirrors `/api/care`; tools in `lib/atlas/`). Reads are RLS-scoped; the only proposed act is a pending knowledge capture.

**Tools**
| Tool | Tier | Effect |
|---|---|---|
| `search_atlas_knowledge` | read | Knowledge Base RAG, citable `source_title` |
| `recall_atlas_memory` | read | Durable `tony_memory` (pinned first) |
| `get_graph_snapshot` | read | Live org snapshot: departments, brands, capabilities sample |
| `list_capabilities` | read | Capability registry (filterable) |
| `propose_atlas_capture` | proposed | File pending `atlas_capture` into Approvals |

**Guardrails:** every fact cited with origin; numbers only from live graph; empty → "I don't have that yet"; executor `atlas_capture` is recommendation-only.

---

## Agent 7: Oracle — Finance Forecast (V1)

**Status:** V1 — live (leadership only)
**Access:** `ceo/coo` only for P&L/cashflow/budget (mirrors `/finance` RLS); proposals are `ceo/coo`.

Oracle reads live finance. Same loop `/api/oracle` (`lib/oracle/`). All numbers live, never a doc figure as live.

**Tools**
| Tool | Tier | Effect |
|---|---|---|
| `get_finance_snapshot` | read | P&L: revenue, COGS, gross, opex, operating profit, capex (2mo window) |
| `get_cashflow_forecast` | read | Cash anchor + 90d opex + 60d inflow, horizons 30/60/90 |
| `get_budget_health` | read | Budgets vs 30d spend, utilization % |
| `search_finance_knowledge` | read | Finance SOPs, citable |
| `propose_oracle_action` | proposed | File pending `oracle_recommendation` — leadership approves, never moves money |

**Guardrails:** finance is `ceo/coo` only; empty → honest `—`; proposals are recommendation-only (`executor.ts:oracle_recommendation` just acknowledges).

---

## Agent 8: Herald — Outreach (V1)

**Status:** V1 — live
**Access:** All can read queue/draft; filing sends is `ceo/coo/department_head`.

Herald drafts follow-ups to leads/creators. Same loop `/api/herald` (`lib/herald/`). Staged sends reuse `log_followup` executor (internal log + reschedule, no external SMTP on approval unless `EMAIL_*` configured — then real email, else copy-paste).

**Tools**
| Tool | Tier | Effect |
|---|---|---|
| `list_outreach_queue` | read | Pending `action_requests` in `bizdev/affiliate/care` |
| `get_outreach_target` | read | Lead or creator by name |
| `search_outreach_knowledge` | read | Outreach SOPs |
| `draft_herald_message` | read | Deterministic draft via `buildLeadFollowUpDraft`/`buildCreatorFollowUpDraft` (no send) |
| `propose_herald_send` | proposed | File pending `log_followup` (`lead_id`/`creator_id` XOR, `channel`, `drafted_message`) |

**Guardrails:** `propose_herald_send` is `approval` tier; executor `log_followup` sends nothing externally in v1 (staged draft).

---

## Agent 9: Prospector — Opportunities (V1)

**Status:** V1 — live
**Access:** All can list/find; filing tasks is `ceo/coo/department_head`.

Prospector scores external prospects HOT/WARM/COLD. Same loop `/api/prospector` (`lib/prospector/`). Webhook `automation_registry key=opportunity_engine` gives real scores; without it, stub honest ranking with `Configure opportunity_engine` note — never invents tier/score as real.

**Tools**
| Tool | Tier | Effect |
|---|---|---|
| `list_prospect_queue` | read | Pending opportunity tasks in Approvals |
| `get_prospect_context` | read | Lead or task by name |
| `find_prospects` | read | Score CSV via webhook or stub |
| `search_prospect_knowledge` | read | BizDev SOPs |
| `propose_prospect_task` | proposed | File pending `create_opportunity_task` (BizDev approves) |

**Guardrails:** never contacts prospect; executor `create_opportunity_task` only opens internal task `due +2d` to BizDev head.

---

## Agent Design Principles (apply to all current and future agents)

1. **One agent, one clear responsibility.** Don't let the company assistant quietly grow into also being the workflow engine — that's how "AI never executes critical actions automatically" erodes over time.
2. **Every recommendation is logged**, whether or not it's approved — this is what makes D-005's "revisit when approval rates are consistently high" review possible later.
3. **No agent gets write access to compliance-sensitive tables** (`distributors`, financial tables) without an explicit, separately-reviewed decision entry in `DECISIONS.md` — this is not a default that loosens automatically as trust builds.
4. **Model choice:** company assistant runs on a Claude Sonnet-class model via the Anthropic API for MVP; if a future agent needs different latency/cost tradeoffs (e.g. a high-volume anomaly scanner), that's a new `DECISIONS.md` entry, not a silent swap.
