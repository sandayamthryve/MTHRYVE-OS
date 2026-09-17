-- Contributor → Department reporting bridge.
--
-- Contributors (hosts / interns) have no OS login; they act through the public
-- /host/<token> portal. Until now a contributor's work was tied to a BRAND
-- (contributor_logs.brand_id) and never reached a DEPARTMENT dashboard, and the
-- portal only knew how to capture live-selling numbers. This migration reuses the
-- existing company-wide reporting spine (daily_reports + daily_report_tasks +
-- tasks) so a contributor's confirmed work surfaces on their DEPARTMENT, exactly
-- like a staff member's daily report.
--
-- Three additive, idempotent changes:
--   1. contributors.department_id (+ free-text assignment) — attach a contributor
--      to a department so their reports land somewhere.
--   2. tasks.contributor_id — a lead/moderator can assign a task to a contributor
--      alongside (or instead of) a user assignee.
--   3. daily_reports.contributor_id + user_id made NULLABLE + a CHECK that EXACTLY
--      ONE of (user_id, contributor_id) is set — the same table now carries both
--      staff reports (user_id) and contributor reports (contributor_id). A partial
--      unique index dedups one report per contributor per day.
--
-- No RLS policy is changed. daily_reports' SELECT policy is org-scoped
-- (org_id = current_org_id()), so it never referenced user_id and continues to
-- surface contributor rows (user_id IS NULL) to the department head / leadership.
-- Contributor rows are written ONLY through the token-validated service-role path.

-- 1) contributors: department_id + optional assignment text ────────────────────
alter table public.contributors add column if not exists department_id uuid;
alter table public.contributors add column if not exists assignment text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'contributors_department_id_fkey'
  ) then
    alter table public.contributors
      add constraint contributors_department_id_fkey
      foreign key (department_id) references public.departments(id) on delete set null;
  end if;
end $$;

create index if not exists ix_contributors_department_id
  on public.contributors (department_id);

-- 2) tasks: contributor_id (assign a task to a contributor) ─────────────────────
alter table public.tasks add column if not exists contributor_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_contributor_id_fkey'
  ) then
    alter table public.tasks
      add constraint tasks_contributor_id_fkey
      foreign key (contributor_id) references public.contributors(id) on delete set null;
  end if;
end $$;

create index if not exists ix_tasks_contributor_id
  on public.tasks (contributor_id);

-- 3) daily_reports: contributor_id, nullable user_id, XOR actor ─────────────────
alter table public.daily_reports add column if not exists contributor_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'daily_reports_contributor_id_fkey'
  ) then
    alter table public.daily_reports
      add constraint daily_reports_contributor_id_fkey
      foreign key (contributor_id) references public.contributors(id) on delete cascade;
  end if;
end $$;

-- user_id becomes nullable so a contributor report can omit it. Existing staff
-- rows all have user_id set, so this widening never rewrites or invalidates them.
alter table public.daily_reports alter column user_id drop not null;

-- Exactly one actor per report. XOR: (user_id present) <> (contributor_id present).
-- Existing rows (user_id set, contributor_id NULL) satisfy TRUE <> FALSE = TRUE.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'daily_reports_actor_present'
  ) then
    alter table public.daily_reports
      add constraint daily_reports_actor_present
      check ((user_id is not null) <> (contributor_id is not null));
  end if;
end $$;

create index if not exists ix_daily_reports_contributor_id
  on public.daily_reports (contributor_id);

-- One report per contributor per work_date (mirrors the staff
-- (org_id, user_id, work_date) unique key). Partial so it never collides with
-- staff rows, whose contributor_id is NULL.
create unique index if not exists uq_daily_reports_org_contributor_workdate
  on public.daily_reports (org_id, contributor_id, work_date)
  where contributor_id is not null;
