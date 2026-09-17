-- Leave Management — the tables /leave has been reading since it was written.
--
-- The page shipped as a view over leave_requests and leave_balances, but no
-- migration ever created them: it has been rendering its empty state for every
-- viewer, and "+ New Request" pointed at a route that did not exist. This
-- creates the schema the page already expects, matching the column names it
-- selects, so the existing reads light up unchanged.
--
-- RLS is the real authority here, as everywhere else in this OS. The server
-- actions check the same rules before writing so we never render a control the
-- policy would reject, but the policies below are what actually enforce them.

-- ── leave_requests ──────────────────────────────────────────────────────────
create table if not exists public.leave_requests (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- The person the leave is FOR. Named employee_id (not user_id) because the
  -- page selects that column.
  employee_id uuid not null references users(id) on delete cascade,
  -- Denormalised so the table renders without a join, and so history survives a
  -- rename or a departure.
  employee_name text not null,
  leave_type text not null,
  start_date date not null,
  end_date date not null,
  -- Inclusive day count. Stored rather than derived so a half-day or a holiday
  -- adjustment can differ from the raw date span.
  duration_days numeric(5,1) not null,
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  approver_id uuid references users(id) on delete set null,
  approver_name text,
  -- Why a request was rejected. Required by the action on reject: a refusal
  -- without a reason is not reviewable after the fact.
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_requests_dates_ordered check (end_date >= start_date),
  constraint leave_requests_duration_positive check (duration_days > 0)
);

create index if not exists leave_requests_org_idx on public.leave_requests(org_id);
create index if not exists leave_requests_employee_idx
  on public.leave_requests(org_id, employee_id, created_at desc);
create index if not exists leave_requests_pending_idx
  on public.leave_requests(org_id, status) where status = 'pending';

comment on table public.leave_requests is
  'Leave applications. Employees file and cancel their own; leadership decides.';

-- ── leave_balances ──────────────────────────────────────────────────────────
create table if not exists public.leave_balances (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  employee_id uuid not null references users(id) on delete cascade,
  leave_type text not null,
  total_entitlement numeric(5,1) not null default 0,
  used numeric(5,1) not null default 0,
  -- Generated, so the number the page shows can never drift from its inputs.
  remaining numeric(5,1) generated always as (total_entitlement - used) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_balances_unique unique (org_id, employee_id, leave_type)
);

create index if not exists leave_balances_employee_idx
  on public.leave_balances(org_id, employee_id);

comment on table public.leave_balances is
  'Per-employee entitlement by leave type. remaining is generated, never written.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Two roles, as the HRMS document specifies. An employee sees and files their
-- own; leadership sees the org and decides. Deciding is deliberately NOT open to
-- the requester, so nobody approves their own leave.
alter table public.leave_requests enable row level security;
alter table public.leave_balances enable row level security;

drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests for select
  using (
    org_id = current_org_id()
    and (
      employee_id = auth.uid()
      or current_user_role() in ('ceo', 'coo', 'department_head')
    )
  );

-- Filing: for yourself only. Leadership filing on someone's behalf is a
-- separate decision and is not granted here.
drop policy if exists leave_requests_insert_own on public.leave_requests;
create policy leave_requests_insert_own on public.leave_requests for insert
  with check (
    org_id = current_org_id()
    and employee_id = auth.uid()
    and status = 'pending'
  );

-- Deciding: leadership, and never on your own request.
drop policy if exists leave_requests_decide on public.leave_requests;
create policy leave_requests_decide on public.leave_requests for update
  using (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo', 'department_head')
    and employee_id <> auth.uid()
  )
  with check (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo', 'department_head')
  );

-- Withdrawing: your own request, and only while nobody has acted on it.
drop policy if exists leave_requests_cancel_own on public.leave_requests;
create policy leave_requests_cancel_own on public.leave_requests for update
  using (
    org_id = current_org_id()
    and employee_id = auth.uid()
    and status = 'pending'
  )
  with check (
    org_id = current_org_id()
    and employee_id = auth.uid()
    and status in ('pending', 'cancelled')
  );

drop policy if exists leave_balances_select on public.leave_balances;
create policy leave_balances_select on public.leave_balances for select
  using (
    org_id = current_org_id()
    and (
      employee_id = auth.uid()
      or current_user_role() in ('ceo', 'coo', 'department_head')
    )
  );

-- Entitlements are set by leadership, not by the person consuming them.
drop policy if exists leave_balances_leadership_write on public.leave_balances;
create policy leave_balances_leadership_write on public.leave_balances for all
  using (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo')
  )
  with check (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo')
  );
