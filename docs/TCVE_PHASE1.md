# Tony Cognitive Visualization Engine (TCVE) — Phase 1

A living, RLS-scoped enterprise graph with Tony (the Executive Brain) pinned at
the center. It becomes Tony's hero view: the `/tony` landing now opens on the
**Cognitive Engine** tab (the graph), with the existing metric **Command View**
constellation one click away. The sidebar navigation is untouched — clean nav is
for _doing_, the TCVE is for _seeing_.

## Step 0 — audit: real tables → graph

All reads are org-scoped by Postgres RLS (`org_id = current_org_id()`) through
the caller's `@supabase/ssr` client; leadership-only nodes are additionally
role-gated in `lib/tony/graph.ts` (defence-in-depth). Live row counts below are
from the current org.

| Table | Live rows | Becomes | Notes |
|---|---|---|---|
| `organizations` | 1 | `brain` (Tony) center | org name + rollup counts |
| `skill_registry` (enabled) | 2 | `agent` nodes | AI Brief, Agent CSI — role-visible only |
| `vesper_clip_jobs` | 0 | `agent` (Vesper) | real clip-job count; omitted if read fails |
| `departments` | 7 | `department` nodes | lead (→ `users`), brand + member counts |
| `brands` | 11 | `brand` / client nodes | status, category, platforms, MTD GMV, tasks |
| `department_brands` | 19 | `department → brand` **edges** | the real dept↔brand relationship; `role` on edge |
| `pods` / `pod_brands` | 0 / 0 | `pod` nodes + `pod → brand` edges | empty today; fully wired |
| `automation_registry` | 1 | `workflow` node | Opportunity Engine (GitHub Actions) — role-visible only |
| `documents` | 10 | `knowledge_hub` + `knowledge` docs | clustered; leadership-sensitive docs hidden for non-leadership |
| `action_requests` (pending) | 1 | `approval` nodes | pending only; role-visible only |
| `tasks` | 3 | brand stats + live signal | open/overdue counts; completion → live pulse |
| `campaigns` | 0 | brand stat (count) | folded into brand summary |
| KPIs (derived) | — | `kpi` nodes | Active Brands, Open Approvals, Open Tasks; **MTD GMV = leadership only** |

**Grounding contract:** nothing is fabricated. A missing value is `null` and
renders as `—`. Only visuals animate (orbit, pulse, edge energy) — never a number.

**Relationships wired as edges:** `tony ↔ agents` (orchestrates, animated),
`tony ↔ departments/pods/workflows/approvals/KPIs`, `department ↔ brand`
(`department_brands`), `pod ↔ brand` (`pod_brands`), `knowledge_hub ↔ doc` and
`doc ↔ department` (`documents.department_id`).

> Not wired (no backing data): a literal `agent ↔ collaborating-department` edge
> — there is no table linking agents to departments, so it is **not** fabricated.
> Agents connect through Tony. Flag for phase 2 if a real mapping is added.

## Build

1. **Graph data API** — `GET /api/tony/graph` → `getTonyGraph()`
   (`lib/tony/graph.ts`). Read-only, org-scoped, assembles `{ nodes, edges,
   pipeline, meta }` with real summary fields per node.
2. **Force graph** — `react-force-graph-2d` (canvas), Tony pinned at origin,
   animated energy edges, glowing active nodes, hover/focus highlight
   (`ForceGraphInner` / `ForceGraphCanvas`).
3. **Interactions** — click → context focus (highlight node + neighbors, fade
   the rest) + drill-down panel with real details and a link to the node's real
   OS page (`DrillDownPanel`); search/command bar ("analyze &lt;brand&gt;",
   `CommandBar`); pan/zoom/drag + zoom controls + click-to-recenter mini-map
   (`MiniMap`); progressive disclosure (expand a department / the knowledge hub).
4. **Reasoning trace** — "watch Tony think" visualizes Tony's **real** request
   pipeline (the Anthropic agentic tool-use loop in `app/api/assistant/route.ts`):
   intent → model tier → RAG retrieval → agent/skill selection → tool use →
   reasoning → validation → recommendation → gated execution → learning. Each
   stage shows caller-scoped real facts where it has them (docs/chunks available,
   skills/workflows visible, your tier, your execution gating). It illustrates the
   real process; it does not invent a run (`ReasoningTrace`, `buildPipeline()`).
5. **Live updates** — Supabase Realtime on two high-signal events: a new
   `action_request` (approval) and a `tasks` update/completion → pulses the
   relevant node + debounced refetch (`useGraphRealtime`). Requires migration
   `0024_tcve_realtime.sql` (adds the two tables to the `supabase_realtime`
   publication — RLS still applies). Degrades silently until applied.
6. **Performance** — built for hundreds of nodes: clustering (knowledge hub) +
   progressive disclosure (department/hub expand), stable node objects so layout
   survives refresh, label culling by zoom. Not over-engineered for 10k.

## Files

**Added**
- `lib/tony/graph-types.ts` — shared graph contract (server/client boundary)
- `lib/tony/graph.ts` — the org-scoped graph assembler
- `app/api/tony/graph/route.ts` — read-only graph endpoint
- `components/tony/cognitive/palette.ts` — type/status → color/size maps
- `components/tony/cognitive/ForceGraphInner.tsx` — the canvas (ssr:false)
- `components/tony/cognitive/ForceGraphCanvas.tsx` — measure + host + minimap
- `components/tony/cognitive/MiniMap.tsx` — overview + viewport rect
- `components/tony/cognitive/DrillDownPanel.tsx` — context-focus drill-down
- `components/tony/cognitive/ReasoningTrace.tsx` — the real pipeline trace
- `components/tony/cognitive/CommandBar.tsx` — search / command
- `components/tony/cognitive/useGraphRealtime.ts` — minimal live updates
- `components/tony/cognitive/CognitiveEngine.tsx` — the orchestrator
- `components/tony/cognitive/TonyHero.tsx` — Cognitive Engine / Command View tabs
- `database/migrations/0024_tcve_realtime.sql` — Realtime publication (additive)
- `docs/TCVE_PHASE1.md` — this document

**Changed**
- `app/(dashboard)/tony/page.tsx` — fetch the graph; render `TonyHero` as the
  hero; the existing constellation stays as the Command View tab
- `package.json` / `package-lock.json` — add `react-force-graph-2d`,
  `framer-motion`

## Known limitations / next

- Realtime is inert until `0024_tcve_realtime.sql` is applied.
- Reasoning trace visualizes the real pipeline structure + real config; it does
  not stream a live model run (deliberate for phase 1 — no extra token spend).
- `pods` / `pod_brands` / `campaigns` are empty today; nodes/edges appear
  automatically once rows exist.
- No `agent ↔ department` collaboration edges (no backing table) — see above.
