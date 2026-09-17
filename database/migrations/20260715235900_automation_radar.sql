-- Mthryve OS — Migration 20260715235900: Automation Radar (repetition patterns)
--
-- Re-versioned from the original 0026_automation_radar.sql to a fresh timestamp
-- version (the 0026 slot was already taken by warehouse_stock_core) so the
-- migration runner actually applies it. Table/column names are IDENTICAL to the
-- original so it matches the deployed app code.
--
-- The detection substrate for "Automation Radar": ONE org-wide engine mines real
-- work (tasks) for repetition and PROPOSES automations, approval-gated. This
-- migration only creates the store + its governance; the detector (server job),
-- the surfaces (a single reusable component filtered per department + an org-wide
-- roll-up) and Tony's read tool live in app code.
--
-- GOVERNING RULES (mirrors the rest of the OS):
--   1. Detection is READ-ONLY over real rows and writes here via the service
--      role. Under threshold → no row (no fabrication).
--   2. NOTHING auto-executes. A proposed automation drafts a PENDING
--      action_request on the shared approval spine; this table only records the
--      pattern + its status. 'keep_human' patterns are never automated.
--   3. ONE engine writes repetition_patterns.department; department tabs render a
--      FILTERED view. Detection is never duplicated per department.
--   4. Standard stack + RLS. Reuses current_org_id() / current_user_role() /
--      current_user_team(). Approvals ('approved'/'automated') are leadership-only,
--      enforced by a guard trigger that mirrors trg_guard_metric_entry_approval.
--
-- Applied to project otepdjhrawtqkzclaxbk (migration `automation_radar`).

-- ── repetition_patterns: one detected pattern of repeated work ────────────────
create table if not exists public.repetition_patterns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  -- Stable identity for a pattern (department + normalized title + assignee), so
  -- re-running the detector UPSERTS the same row instead of duplicating it.
  pattern_key text not null,
  normalized_title text not null,          -- lowercased, dates/numbers/IDs stripped
  sample_titles jsonb not null default '[]',  -- a few real source titles, for trust
  department text,                          -- from assignee_id → users.department_id → departments.name
  assignee_id uuid references public.users(id) on delete set null,
  occurrences int not null default 0,
  first_seen date,
  last_seen date,
  cadence text,                             -- daily / weekly / biweekly / monthly / irregular
  avg_interval_days numeric,
  est_minutes_each int,                     -- task metadata when present, else a sensible default
  time_cost_per_month numeric,              -- est_minutes_each × monthly frequency
  automatability text check (automatability in ('automatable','templatable','sop','keep_human')),
  suggested_path text,                      -- the honest next step (link a capability / template / SOP)
  matched_capability_id uuid references public.capabilities(id) on delete set null,
  matched_workflow text,                    -- a real automation_registry key when automatable
  status text not null default 'detected'
    check (status in ('detected','proposed','approved','dismissed','automated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, pattern_key)
);

create index if not exists repetition_patterns_org_dept_idx
  on public.repetition_patterns(org_id, department);
create index if not exists repetition_patterns_org_cost_idx
  on public.repetition_patterns(org_id, time_cost_per_month desc);
create index if not exists repetition_patterns_status_idx
  on public.repetition_patterns(org_id, status);

-- ── updated_at ────────────────────────────────────────────────────────────────
drop trigger if exists repetition_patterns_set_updated_at on public.repetition_patterns;
create trigger repetition_patterns_set_updated_at before update on public.repetition_patterns
  for each row execute function public.set_updated_at();

-- ── Approval guard: only leadership may move a pattern to approved/automated ───
-- Team members may set status to 'proposed'/'dismissed' for their own department
-- (the RLS UPDATE policy below), but flipping to 'approved' or 'automated' — the
-- states that authorize acting on a pattern — is leadership-only, enforced here at
-- the row level so no client path can approve without a leader. Mirrors
-- guard_metric_entry_approval (0025_hybrid_metrics_floor) and op_records_approval_guard.
create or replace function public.guard_repetition_pattern_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.status is distinct from old.status and new.status in ('approved','automated')) then
    if coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '') not in ('ceo', 'coo', 'department_head')
       and public.current_user_role() not in ('ceo', 'coo', 'department_head') then
      raise exception 'Only leadership may approve or mark a repetition pattern automated'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

revoke execute on function public.guard_repetition_pattern_approval() from public, anon, authenticated;

drop trigger if exists trg_guard_repetition_pattern_approval on public.repetition_patterns;
create trigger trg_guard_repetition_pattern_approval before update on public.repetition_patterns
  for each row execute function public.guard_repetition_pattern_approval();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.repetition_patterns enable row level security;

-- Org read: every department sees its slice (the UI filters by department; the
-- org-wide roll-up shows all). RLS scopes rows to the caller's org.
drop policy if exists repetition_patterns_org_read on public.repetition_patterns;
create policy repetition_patterns_org_read on public.repetition_patterns for select
  using (org_id = public.current_org_id());

-- Insert: leadership only. The detector writes with the service-role client
-- (bypasses RLS), so this policy just closes the door on client-side inserts.
drop policy if exists repetition_patterns_leadership_insert on public.repetition_patterns;
create policy repetition_patterns_leadership_insert on public.repetition_patterns for insert
  with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );

-- Update: leadership anywhere, OR a team member for THEIR OWN department
-- (current_user_team, case-insensitive). Team members can propose/dismiss their
-- own patterns; the guard trigger above still blocks them from approved/automated.
drop policy if exists repetition_patterns_team_update on public.repetition_patterns;
create policy repetition_patterns_team_update on public.repetition_patterns for update
  using (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or lower(coalesce(department, '')) = lower(coalesce(public.current_user_team(), ''))
    )
  )
  with check (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or lower(coalesce(department, '')) = lower(coalesce(public.current_user_team(), ''))
    )
  );

-- ── Skill registry: register the detector as a discoverable skill ─────────────
-- The scout is the DISCOVERY skill (mine work → propose). Actual automations live
-- in automation_registry; this row just makes the capability discoverable to Tony.
-- Seeded once per existing org (mirrors the metric_catalog per-org seed pattern);
-- guarded by NOT EXISTS so it's re-runnable without depending on a named constraint.
insert into public.skill_registry (org_id, key, name, description, category, input_schema, required_role, enabled)
select
  o.id,
  'automation_scout',
  'Automation Scout',
  'Mines the OS for repetitive work and proposes automations (approval-gated). Reads repetition_patterns; every proposal routes to a pending action_request — nothing auto-executes.',
  'automation',
  '{}'::jsonb,
  'team_member',
  true
from public.organizations o
where not exists (
  select 1 from public.skill_registry s
  where s.org_id = o.id and s.key = 'automation_scout'
);
