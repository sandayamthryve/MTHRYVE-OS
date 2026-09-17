# Briefing staleness audit — frozen numbers in cached text

**PR 7 deliverable.** The Executive Briefing on the Command Center was serving
10-day-old figures as if current: the card rendered `org_briefings.summary` — AI
prose with `MTD GMV ₱5,679,431 · 11 brands · zero snapshots` baked in on Jul 18 —
while the live truth was ₱12.3M / 12 brands / 7 department snapshots.

**The defect class:** an AI/generator bakes live figures into a **stored text
column** (`*_briefings.summary`, `.action_plan`, `account_review_briefs.payload`),
and a later render shows that frozen prose with no live figure beside it and no
prominent age signal — so a stale narrative reads as current fact.

**The fix pattern (applied to the Command Center, then the two DEFECTs below):**
keep the narrative cached, but (a) resolve the headline **figures live at render**
from canonical sources and show them beside the prose, and (b) show an **unmissable
staleness banner** once the narrative is older than 24h. See `app/(dashboard)/page.tsx`
(Executive Briefing card), `lib/briefings/exec-figures.ts`
(`getExecBriefingFigures`, `getAccountBriefingFigures`,
`getDepartmentBriefingFigures`, `briefingStaleness`), and the one shared banner
`components/briefings/StalenessBanner.tsx`. The narrative refresh runs on the same
GitHub Actions daily schedule via the bearer routes under `app/api/automation/*-briefings`,
each backed by a shared generation core (`lib/briefings/*-briefing-core.ts`) so the
human "Refresh" button and the machine run can never diverge.

This document inventories **every other** surface with the same shape so the fix
can be propagated deliberately. Verdicts: **OK** = numbers live at render, text is
only qualitative · **PARTIAL** = has a generated-at timestamp but frozen numbers,
no live figure · **DEFECT** = frozen numbers shown as current, no live figure AND
no age signal.

---

## Fixed reference

### 1. `org_briefings.summary` — Command Center — **OK (fixed in PR 7)**
- Generator: `lib/briefings/org-briefing-core.ts` (`buildOrgUserPrompt` bakes GMV
  MTD, prior-month GMV, efficiency %, quality, capacity, approvals; summary written
  in `runOrgBriefing`). Also driven by `lib/briefings/generate.ts` (interactive
  refresh) and `app/api/automation/exec-briefing/route.ts` (GitHub Actions daily).
- Render: `app/(dashboard)/page.tsx` — Executive Briefing card.
- Live figures + staleness banner both present (`getExecBriefingFigures` /
  `briefingStaleness`), plus the existing generated-at line.

---

## DEFECTs — fixed in PR 8

Both surfaces below rendered frozen numbers with no live figure and no age signal.
Both now (a) resolve their headline figures LIVE at render from the canonical
source, (b) show the shared `StalenessBanner` once the narrative crosses 24h, and
(c) print the generation date in the footer. Account briefings additionally honour
the CLIENT-FACING rule: any figure that can't be resolved live renders "—", never a
stale number and never a fabricated 0.

### 2. `account_briefings.summary` — Accounts page — **OK (fixed in PR 8)**
- Generator now runs through the shared core `lib/briefings/account-briefing-core.ts`
  (`runAccountBriefing`), driven by both `generateAccountBriefing` (interactive) and
  `app/api/automation/account-briefings/route.ts` (GitHub Actions daily).
- Render: `app/(dashboard)/accounts/page.tsx` — live per-brand GMV strip
  (`getAccountBriefingFigures`, sourced from `tiktok_shop_performance`) + staleness
  banner keyed on `account_briefings.created_at` + generation date in the footer.
  Verified live: BodegaTrends MTD GMV ₱2,920 (11 live days), latest-day GMV ₱369
  (2026-07-27), prior-month (2026-06) → "—" (no June rows — an honest dash, never
  ₱0). The 13-day-old brief trips the banner.

### 3. `department_briefings.action_plan` — Departments & Metrics pages — **OK (fixed in PR 8)**
- Generator now runs through the shared core
  `lib/briefings/department-briefing-core.ts` (`runDepartmentActionPlan`), driven by
  both `generateDepartmentActionPlan` (interactive) and
  `app/api/automation/department-briefings/route.ts` (GitHub Actions daily).
- Render: `components/departments/DepartmentNarrative.tsx` (mounted on
  `app/(dashboard)/departments/page.tsx` and `app/(dashboard)/metrics/page.tsx`) —
  live snapshot strip (`getDepartmentBriefingFigures` / `deptFiguresFromSnapshot`,
  from `metrics_snapshots`) + staleness banner keyed on
  `department_briefings.created_at` + generation date in the footer. Verified live:
  E-Commerce Ops efficiency "—" and capacity "—" (both null — honest dash, not 0%),
  quality 100%, GMV impact ₱14,086,059 (period to 2026-07-27). The 17-day-old plan
  trips the banner.

---

## PARTIALs — generated-at present, but frozen numbers and no live reconciliation

The Command Center fix was simply never propagated into the reusable component.

### 4. `<AiBrief>` — Reports (org + department), Finance, Campaigns (account)
- Render: `components/briefings/AiBrief.tsx` shows a generated-at `Meta` line but no
  live-figure strip and no staleness banner. Reused at:
  - `app/(dashboard)/reports/page.tsx` — org `summary` **and** department
    `action_plan`.
  - `app/(dashboard)/finance/page.tsx` — `finance_briefings.summary` (cash / runway
    baked; the live cash-flow forecast is a *separate* card below, not co-located).
  - `app/(dashboard)/campaigns/page.tsx` — `account_briefings.summary`.
- Note (secondary "frozen re-consumed" path): `campaigns/page.tsx` and
  `creative-studio/page.tsx` feed `acctBrief.summary` (frozen prose) as *context
  into a further generation*.
- Remedy: give `<AiBrief>` an optional live-figures slot + `briefingStaleness`
  banner; pass canonical figures per scope.

### 5. Tony Command View — `org_briefings.summary` + `department_briefings.action_plan`
- Read/attach: `lib/tony/nodes.ts` (`brief.text` + `briefMeta` = model · confidence
  · created_at). Render: `components/tony/TonyConstellation.tsx`.
- The node's own `metric` is live, but the brief prose numbers are frozen beside it
  with no reconciliation. generated-at is in `briefMeta`.

### 6. `account_review_briefs.payload` — Metrics page panel (history re-open)
- Generator: `lib/briefings/account-review.ts` (+ scenarios); persisted by
  `app/api/metrics/brief/route.ts`.
- Render: `components/metrics/AccountReviewBriefPanel.tsx`. **Fresh generate** re-
  reads metrics live (OK). **Re-open from history** (`GET /api/metrics/brief`)
  returns frozen `entries`/`rollup`/`summary` from stored `payload`, and the panel
  never surfaces `payload.meta.generated_at` — only the period dates.
- Remedy: on history re-open, surface `meta.generated_at` + a staleness banner, or
  re-resolve the metrics table live for the stored scope.

### 7. `account_review_briefs.payload` — Live-ops report detail
- Generator: `lib/live-ops/brief.ts` (session KPIs/deltas baked; `meta.generated_at`
  stamped). Render: `app/(dashboard)/live-ops/reports/[id]/page.tsx` (`BriefView`) —
  grounded/model/KPI-count badges but **no generated-at**. Lower risk: a live report
  is a fixed historical session.

### 8. Council briefs & Executive Feed — `action_requests` text — low risk
- `lib/council/members.ts` (`memberDraft` → recommendation text may embed figures);
  `components/ceo/ExecutiveFeed.tsx` renders `recommendation` with `created_at`.
  These are pending queue items awaiting a decision (each carries created_at), not
  "current figure" displays.

---

## Checked and cleared — OK (live at render, no frozen text)

- `lib/os/snapshot.ts` (`buildSnapshot`) — pure live read; `generated_at` stamped;
  honest nulls.
- `lib/ceo/mission-control.ts` — every KPI/chart read live; honest nulls.
- `lib/briefings/metric-briefs.ts` — WHAT/HOW derived deterministically from the
  live metric; only WHY/IMPACT are AI (cache-keyed on the numbers, honest
  fallbacks). The figure on each tile is live.

---

## Recommendation

Both DEFECTs are fixed in PR 8, reusing the exact PR 7 primitives — live figure
resolution in `lib/briefings/exec-figures.ts` and the (now shared) staleness banner.
**After PR 8 no briefing surface renders an UNDATED cached number:** the two DEFECTs
were the only surfaces with no age signal at all, and both now print a generation
date and trip the banner past 24h. The remaining **PARTIALs (#4–#8) already carry a
generated-at stamp** (dated, but without a live-figure strip or a >24h banner); they
are the next, lower-priority increment. The cleanest structural fix for them is to
teach the shared `<AiBrief>` component the live-figure slot + `StalenessBanner` once,
which covers Reports, Finance and Campaigns together.
