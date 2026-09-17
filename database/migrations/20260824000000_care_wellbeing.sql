-- Care agent — wellbeing_pulses + care_check_ins
-- Provides Care with an opt-in, anonymized pulse signal without touching users table.

-- ── wellbeing_pulses: opt-in mood check (1-5 + optional note) ────────────────
create table if not exists public.wellbeing_pulses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  mood smallint not null check (mood between 1 and 5),
  note text,
  is_anonymous boolean not null default false,
  pulse_date date not null default (now() at time zone 'Asia/Manila')::date,
  created_at timestamptz not null default now(),
  unique (org_id, user_id, pulse_date)
);

create index if not exists ix_wellbeing_pulses_org_user_date on public.wellbeing_pulses(org_id, user_id, pulse_date desc);
create index if not exists ix_wellbeing_pulses_org_date on public.wellbeing_pulses(org_id, pulse_date desc);

-- updated_at trigger not needed — pulses are insert-only; keep created_at.

alter table public.wellbeing_pulses enable row level security;

-- Org read: member sees own pulses + (if HR/leadership) team aggregates via care tools.
-- For v1, any member can read rows in own org (RLS org-scoped). Anonymity is enforced
-- in application code: aggregates strip user_id when is_anonymous.
drop policy if exists wellbeing_pulses_org_read on public.wellbeing_pulses;
create policy wellbeing_pulses_org_read on public.wellbeing_pulses for select
  using (org_id = public.current_org_id());

drop policy if exists wellbeing_pulses_self_insert on public.wellbeing_pulses;
create policy wellbeing_pulses_self_insert on public.wellbeing_pulses for insert
  with check (
    org_id = public.current_org_id()
    and user_id = auth.uid()
  );

drop policy if exists wellbeing_pulses_self_update on public.wellbeing_pulses;
create policy wellbeing_pulses_self_update on public.wellbeing_pulses for update
  using (org_id = public.current_org_id() and user_id = auth.uid())
  with check (org_id = public.current_org_id() and user_id = auth.uid());

-- ── care_check_ins: structured check-in drafts the Care agent proposes ───────
-- Not strictly required — the agent files generic action_requests with type
-- care_check_in — but this table gives Care a readable ledger for the Care page.
create table if not exists public.care_check_ins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  action_request_id uuid references public.action_requests(id) on delete set null,
  reason text not null,
  mood smallint check (mood between 1 and 5),
  status text not null default 'proposed' check (status in ('proposed','approved','dismissed','completed')),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_care_check_ins_org_user on public.care_check_ins(org_id, user_id);
create index if not exists ix_care_check_ins_org_status on public.care_check_ins(org_id, status);

drop trigger if exists care_check_ins_set_updated_at on public.care_check_ins;
create trigger care_check_ins_set_updated_at before update on public.care_check_ins
  for each row execute function public.set_updated_at();

alter table public.care_check_ins enable row level security;

drop policy if exists care_check_ins_org_read on public.care_check_ins;
create policy care_check_ins_org_read on public.care_check_ins for select
  using (org_id = public.current_org_id());

drop policy if exists care_check_ins_leadership_insert on public.care_check_ins;
create policy care_check_ins_leadership_insert on public.care_check_ins for insert
  with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo','coo','department_head')
  );

drop policy if exists care_check_ins_leadership_update on public.care_check_ins;
create policy care_check_ins_leadership_update on public.care_check_ins for update
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo','coo','department_head'))
  with check (org_id = public.current_org_id() and public.current_user_role() in ('ceo','coo','department_head'));
