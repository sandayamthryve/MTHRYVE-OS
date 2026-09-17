-- Mthryve OS — Migration 0025: AI Account Review Briefs (Phase 3)
--
-- Tony reads the org's POPULATED metrics (metrics_snapshots + brand_platform_
-- metrics, judged against metric_targets — the PASTE 1 floor) and produces a
-- management-ready Account Review Brief per department/period. Each brief is a
-- structured, GROUNDED narrative persisted here so it can be re-opened from the
-- history list and exported (xlsx / pdf).
--
-- GOVERNING RULES (Phase 3):
--   • The brief is grounded ONLY in real metric rows for the selected scope —
--     the generation endpoint never invents numbers (see lib/metrics/review.ts
--     + lib/briefings/account-review.ts). This table only stores the result.
--   • A brief is advisory. Its recommendations do NOTHING on their own; a human
--     "Send to approval" stages a PENDING action_request (the D-005 spine).
--   • No destructive ops: org members can read and insert, nothing more. There
--     is deliberately no UPDATE or DELETE policy, so RLS denies both.
--
-- Applied to project otepdjhrawtqkzclaxbk together with this commit.

create table public.account_review_briefs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id()
                  references public.organizations (id) on delete cascade,
  department    text not null,
  brand_id      uuid references public.brands (id) on delete set null,
  period_start  date not null,
  period_end    date not null,
  summary       text,
  payload       jsonb not null default '{}'::jsonb,
  generated_by  uuid default auth.uid()
                  references public.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint account_review_briefs_period_ck check (period_end >= period_start)
);

-- History list reads newest-first, both org-wide and scoped to a department.
create index account_review_briefs_org_idx
  on public.account_review_briefs (org_id, created_at desc);
create index account_review_briefs_scope_idx
  on public.account_review_briefs (org_id, department, period_end desc);

alter table public.account_review_briefs enable row level security;

-- Read: any member of the caller's org (briefs are org-wide leadership context).
create policy account_review_briefs_select on public.account_review_briefs
  for select using (org_id = public.current_org_id());

-- Insert: org-open — the generation endpoint further gates who may generate, but
-- any authenticated org member's row is accepted as long as it is their org.
create policy account_review_briefs_insert on public.account_review_briefs
  for insert with check (org_id = public.current_org_id());

-- No UPDATE / DELETE policies on purpose: a persisted brief is an immutable
-- record of what the model said over the numbers at generation time.
