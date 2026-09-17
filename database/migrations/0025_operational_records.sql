-- Mthryve OS — Migration 0025: Operational Records + Roll-Down Routing
--
-- Four operational record types — Campaigns, Promotions, Missions, Rewards —
-- share ONE unified table (op_records) and ONE standardized approval workflow
-- that REUSES the existing Action & Approval spine (public.action_requests +
-- public.action_audit). There is no parallel approval system: a submission
-- drafts an action_request for a human to approve, and every op_record state
-- transition is written to action_audit by the guard/audit trigger below.
--
-- GOVERNING RULES:
--   1. Reuse the action_requests / action_audit spine — the app submits by
--      drafting an action_request (system producer, service role, since RLS
--      only lets leadership INSERT action_requests) and decides through the
--      same ar_update policy the Approval Queue uses.
--   2. Money is NEVER moved automatically. Budget / reward values live in
--      details jsonb and are recorded + routed for human action only.
--   3. Standard stack + RLS. Reuses current_org_id() and current_user_role().
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ── op_records: the one unified operational record ────────────────────────────
create table if not exists public.op_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  record_type text not null check (record_type in ('campaign','promotion','mission','reward')),
  brand_id uuid references public.brands(id) on delete set null,
  title text not null,
  details jsonb not null default '{}',            -- type-specific fields
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','rejected','revision_requested','completed')),
  assigned_team text,
  start_date date,
  end_date date,                                  -- campaign / promotion timelines
  created_by uuid default auth.uid() references public.users(id) on delete set null,
  approved_by uuid references public.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists op_records_org_type_status_idx
  on public.op_records(org_id, record_type, status);
create index if not exists op_records_brand_idx on public.op_records(brand_id);

-- ── op_record_routing: roll-down acknowledgements per department ──────────────
create table if not exists public.op_record_routing (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  op_record_id uuid not null references public.op_records(id) on delete cascade,
  department text not null,                        -- Marketing, Creatives, Affiliate, Live Ops,
                                                   -- Warehouse, Customer Service, Finance, Business Development
  routed_at timestamptz not null default now(),
  routed_by uuid references public.users(id) on delete set null,
  acknowledged boolean not null default false,
  acknowledged_by uuid references public.users(id) on delete set null,
  acknowledged_at timestamptz
);

create index if not exists op_record_routing_record_idx on public.op_record_routing(op_record_id);
create index if not exists op_record_routing_org_dept_idx on public.op_record_routing(org_id, department);

-- ── updated_at ────────────────────────────────────────────────────────────────
drop trigger if exists op_records_set_updated_at on public.op_records;
create trigger op_records_set_updated_at before update on public.op_records
  for each row execute function public.set_updated_at();

-- ── Approval guard: only leadership may move a record into an approval state ───
-- The status/approved_* columns are org-open for RLS UPDATE (so a creator can
-- draft/submit/revise), but flipping status to approved/rejected — or stamping
-- approved_by/approved_at — is restricted to ceo/coo/department_head here, at
-- the row level, so no client path can approve a record without a leader.
create or replace function public.op_records_approval_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.status is distinct from old.status and new.status in ('approved','rejected'))
     or (new.approved_by is distinct from old.approved_by)
     or (new.approved_at is distinct from old.approved_at) then
    if public.current_user_role() not in ('ceo','coo','department_head') then
      raise exception 'op_records: only ceo/coo/department_head may approve or reject a record'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.op_records_approval_guard() from public, anon, authenticated;

drop trigger if exists op_records_approval_guard on public.op_records;
create trigger op_records_approval_guard before update on public.op_records
  for each row execute function public.op_records_approval_guard();

-- ── Transition audit: every op_record state change lands in action_audit ──────
-- This is what makes "every transition writes to action_audit" true at the DB
-- level, independent of app code — reusing the SAME audit table as the spine.
create or replace function public.op_records_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
    values (
      new.org_id, null, 'op_record.' || new.status, auth.uid(),
      coalesce(public.current_user_role()::text, 'system'),
      jsonb_build_object('op_record_id', new.id, 'record_type', new.record_type, 'title', new.title, 'to', new.status)
    );
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
    values (
      new.org_id, null, 'op_record.' || new.status, auth.uid(),
      coalesce(public.current_user_role()::text, 'system'),
      jsonb_build_object('op_record_id', new.id, 'record_type', new.record_type, 'title', new.title,
                         'from', old.status, 'to', new.status)
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.op_records_audit() from public, anon, authenticated;

drop trigger if exists op_records_audit on public.op_records;
create trigger op_records_audit after insert or update on public.op_records
  for each row execute function public.op_records_audit();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.op_records enable row level security;
alter table public.op_record_routing enable row level security;

-- op_records: org read; org-open create/draft/submit/edit (the guard trigger is
-- the real gate on approval fields).
drop policy if exists op_records_select on public.op_records;
create policy op_records_select on public.op_records for select
  using (org_id = public.current_org_id());

drop policy if exists op_records_insert on public.op_records;
create policy op_records_insert on public.op_records for insert
  with check (org_id = public.current_org_id());

drop policy if exists op_records_update on public.op_records;
create policy op_records_update on public.op_records for update
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());

-- op_record_routing: org read; org-open insert (roll-down) and update (ack).
drop policy if exists op_record_routing_select on public.op_record_routing;
create policy op_record_routing_select on public.op_record_routing for select
  using (org_id = public.current_org_id());

drop policy if exists op_record_routing_insert on public.op_record_routing;
create policy op_record_routing_insert on public.op_record_routing for insert
  with check (org_id = public.current_org_id());

drop policy if exists op_record_routing_update on public.op_record_routing;
create policy op_record_routing_update on public.op_record_routing for update
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());
