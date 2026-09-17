-- Mthryve OS — Migration 0026: RTS (Return to Seller) + Case Monitoring
--
-- Two additive modules bolted onto the Warehouse spine:
--
--   1. RTS — REUSES public.return_cases as its base. RTS records are ordinary
--      return_cases rows with the new rts_* columns populated (rts_number marks
--      a row as an RTS record). Nothing is duplicated: the RTS view derives its
--      shipping analytics (total / per-brand / monthly / average) from the
--      recorded shipping_fee column. Shipping fees are RECORDED and SUMMED,
--      never moved — money never auto-transfers.
--
--   2. Case Monitoring — a NEW public.cases table plus a chronological
--      public.case_updates timeline. A case auto-inherits its identity from an
--      RTS record (rts_id FK) so nothing is re-encoded. Assignment REUSES the
--      existing public.tasks spine (the app creates a task for the assignee),
--      and every case status transition + assignment change is written to the
--      SHARED public.action_audit trail by the trigger below — the same audit
--      table the Action & Approval spine uses. There is no parallel audit log.
--
-- GOVERNING RULES:
--   1. Shipping fees are recorded + summed only; no automatic money movement.
--   2. Every case status transition and assignment is audited (action_audit).
--   3. RLS on all three surfaces. Warehouse team writes; leadership
--      (ceo/coo/department_head) approves/closes — enforced by the guard
--      trigger so no client path can resolve/close a case without a leader.
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ── PART A.1 — Extend return_cases with RTS fields (all nullable, additive) ────
-- The existing return-case columns (order_ref, sku, product_name, units, reason,
-- fault, status, reported_date, resolved_date, …) are untouched. rts_status
-- defaults to 'pending_verification'; a row only reads as an RTS record when
-- rts_number is populated (the RTS form always sets one), so legacy rows stay
-- out of the RTS view.
alter table public.return_cases
  add column if not exists rts_number         text,
  add column if not exists order_number       text,
  add column if not exists customer_name      text,
  add column if not exists warehouse_staff_id uuid references public.users(id) on delete set null,
  add column if not exists courier            text,
  add column if not exists shipping_fee       numeric,
  add column if not exists date_received      date,
  add column if not exists rts_status         text default 'pending_verification';

-- Guard the RTS workflow vocabulary. Added separately (not inline) so re-running
-- the migration is idempotent even if the column already exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'return_cases_rts_status_check'
  ) then
    alter table public.return_cases
      add constraint return_cases_rts_status_check
      check (rts_status is null or rts_status in
        ('pending_verification','for_packaging','ready_for_shipment','shipped','completed','cancelled'));
  end if;
end $$;

create index if not exists return_cases_rts_number_idx
  on public.return_cases(org_id, rts_number) where rts_number is not null;

-- ── PART A.2 — cases: the monitored case ──────────────────────────────────────
create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  case_number text,
  rts_id uuid references public.return_cases(id) on delete set null,
  brand_id uuid references public.brands(id) on delete set null,
  product text,
  sku text,
  customer text,
  reason text,
  shipping_details text,
  assigned_to uuid references public.users(id) on delete set null,
  priority text not null default 'medium' check (priority in ('low','medium','high','urgent')),
  due_date date,
  status text not null default 'new'
    check (status in ('new','assigned','under_investigation','awaiting_action',
                      'in_progress','pending_resolution','resolved','closed')),
  created_by uuid default auth.uid() references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cases_org_status_idx on public.cases(org_id, status);
create index if not exists cases_brand_idx       on public.cases(brand_id);
create index if not exists cases_assigned_idx     on public.cases(assigned_to);
create index if not exists cases_rts_idx          on public.cases(rts_id);

-- ── PART A.3 — case_updates: the chronological remarks / progress timeline ─────
create table if not exists public.case_updates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  user_id uuid default auth.uid() references public.users(id) on delete set null,
  remarks text,
  attachments jsonb,
  created_at timestamptz not null default now()
);

create index if not exists case_updates_case_idx on public.case_updates(case_id, created_at);

-- ── updated_at ────────────────────────────────────────────────────────────────
drop trigger if exists cases_set_updated_at on public.cases;
create trigger cases_set_updated_at before update on public.cases
  for each row execute function public.set_updated_at();

-- ── Approval guard: only leadership may resolve or close a case ────────────────
-- status is org-open for RLS UPDATE (so Warehouse staff can drive a case through
-- the investigation stages), but landing it in a terminal 'resolved'/'closed'
-- state is restricted to ceo/coo/department_head here, at the row level, so no
-- client path can close a case without a leader.
create or replace function public.cases_close_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status and new.status in ('resolved','closed') then
    if public.current_user_role() not in ('ceo','coo','department_head') then
      raise exception 'cases: only ceo/coo/department_head may resolve or close a case'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.cases_close_guard() from public, anon, authenticated;

drop trigger if exists cases_close_guard on public.cases;
create trigger cases_close_guard before update on public.cases
  for each row execute function public.cases_close_guard();

-- ── Transition + assignment audit: every case change lands in action_audit ────
-- This is what makes "every status transition and assignment is audited" true at
-- the DB level, independent of app code — reusing the SAME audit table as the
-- Action & Approval spine.
create or replace function public.cases_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
    values (
      new.org_id, null, 'case.' || new.status, auth.uid(),
      coalesce(public.current_user_role()::text, 'system'),
      jsonb_build_object('case_id', new.id, 'case_number', new.case_number,
                         'rts_id', new.rts_id, 'to', new.status)
    );
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
      values (
        new.org_id, null, 'case.' || new.status, auth.uid(),
        coalesce(public.current_user_role()::text, 'system'),
        jsonb_build_object('case_id', new.id, 'case_number', new.case_number,
                           'from', old.status, 'to', new.status)
      );
    end if;
    if new.assigned_to is distinct from old.assigned_to then
      insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
      values (
        new.org_id, null, 'case.assigned', auth.uid(),
        coalesce(public.current_user_role()::text, 'system'),
        jsonb_build_object('case_id', new.id, 'case_number', new.case_number,
                           'from', old.assigned_to, 'to', new.assigned_to,
                           'due_date', new.due_date, 'priority', new.priority)
      );
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.cases_audit() from public, anon, authenticated;

drop trigger if exists cases_audit on public.cases;
create trigger cases_audit after insert or update on public.cases
  for each row execute function public.cases_audit();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.cases        enable row level security;
alter table public.case_updates enable row level security;

-- cases: org read; org-open create/edit (Warehouse team writes). The guard
-- trigger is the real gate on resolve/close; delete is leadership-only.
drop policy if exists cases_select on public.cases;
create policy cases_select on public.cases for select
  using (org_id = public.current_org_id());

drop policy if exists cases_insert on public.cases;
create policy cases_insert on public.cases for insert
  with check (org_id = public.current_org_id());

drop policy if exists cases_update on public.cases;
create policy cases_update on public.cases for update
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());

drop policy if exists cases_delete on public.cases;
create policy cases_delete on public.cases for delete
  using (org_id = public.current_org_id()
         and public.current_user_role() in ('ceo','coo','department_head'));

-- case_updates: read anything in an org-visible case; a user may only post an
-- update as themselves; deletes are author-only. Mirrors task_comments.
drop policy if exists case_updates_select on public.case_updates;
create policy case_updates_select on public.case_updates for select
  using (case_id in (select id from public.cases where org_id = public.current_org_id()));

drop policy if exists case_updates_insert on public.case_updates;
create policy case_updates_insert on public.case_updates for insert
  with check (user_id = auth.uid()
              and case_id in (select id from public.cases where org_id = public.current_org_id()));

drop policy if exists case_updates_delete on public.case_updates;
create policy case_updates_delete on public.case_updates for delete
  using (user_id = auth.uid());
