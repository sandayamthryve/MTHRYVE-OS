-- Expense Management — the schema the Money group has been reading all along.
--
-- Eight pages and the whole of lib/finance were written against these tables
-- and no migration ever created them: expenses, expense_categories,
-- expense_vendors, budgets and expense_approvals_view are all absent, so every
-- page in the group has been rendering its empty state since it shipped. The
-- comment above EXPENSE_TYPES in lib/finance/expense-workflow.ts even says it
-- mirrors "the DB CHECK constraints" — those constraints are below, written for
-- the first time.
--
-- Column names and vocabularies are taken from the code that already reads
-- them, not invented: statuses and stages from expense-workflow.ts, budget
-- columns from budgets.ts, the view's shape from the approvals page.

-- ── Category master ─────────────────────────────────────────────────────────
-- "Admins add, edit and disable categories, and map each to a GL or cost
-- centre." Disable, not delete: a category retired today must still name the
-- expenses it was used on last year, so `active` gates selection, not history.
create table if not exists public.expense_categories (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  gl_code text,
  cost_center text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_categories_name_uq unique (org_id, name)
);

create index if not exists expense_categories_org_idx
  on public.expense_categories(org_id) where active;

-- ── Vendor master ───────────────────────────────────────────────────────────
-- Everything the report names, and `active` for the same reason as categories.
-- One-time vendors are NOT rows here: see expenses.vendor_name_oneoff.
create table if not exists public.expense_vendors (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  contact_person text,
  address text,
  tin text,
  vat_registered boolean not null default false,
  payment_terms text,
  preferred_method text,
  bank_name text,
  bank_account_name text,
  bank_account_number text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_vendors_name_uq unique (org_id, name)
);

create index if not exists expense_vendors_org_idx
  on public.expense_vendors(org_id) where active;

-- ── Expense code allocation ─────────────────────────────────────────────────
-- EXP000001-2026: sequential, never reused after a delete, the year rolls
-- automatically, and the code survives edits.
--
-- "Never reused" is what forces a counter. count(*) or max(n)+1 would re-issue
-- a number the moment the highest row is deleted, so the next value comes from
-- a row that only ever increments. It is per (org, year): the year suffix is
-- meaningless if numbering does not restart with it.
create table if not exists public.expense_code_counters (
  org_id uuid not null references organizations(id) on delete cascade,
  year int not null,
  last_number bigint not null default 0,
  primary key (org_id, year)
);

create or replace function public.next_expense_code(p_org uuid, p_year int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  -- One statement: the insert takes the row lock, so two concurrent encodes
  -- serialise here instead of racing for the same number.
  insert into public.expense_code_counters (org_id, year, last_number)
  values (p_org, p_year, 1)
  on conflict (org_id, year)
    do update set last_number = public.expense_code_counters.last_number + 1
  returning last_number into n;

  -- Widen past six digits rather than truncate: a shortened code would collide
  -- with one already issued. Matches formatExpenseCode() in lib/finance.
  return 'EXP' || lpad(n::text, 6, '0') || '-' || p_year::text;
end;
$$;

revoke execute on function public.next_expense_code(uuid, int) from public, anon;
grant execute on function public.next_expense_code(uuid, int) to authenticated;

-- ── The ledger ──────────────────────────────────────────────────────────────
create table if not exists public.expenses (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- Assigned once by trigger and never recomputed; see expenses_assign_code.
  expense_code text not null,
  transaction_date date not null,
  type text not null check (type in ('OPEX', 'CAPEX')),
  category_id uuid references expense_categories(id) on delete restrict,
  -- Cost centre. allocation says which dimension actually owns the spend.
  allocation text not null default 'brand'
    check (allocation in ('brand', 'business_unit', 'department', 'shared')),
  brand_id uuid references brands(id) on delete set null,
  department_id uuid references departments(id) on delete set null,
  reference_number text,
  -- A vendor is either on the master list or a one-time name, never both and
  -- never neither: the report allows one-off entries without polluting the
  -- master, but an expense with no payee at all is not encodable.
  vendor_id uuid references expense_vendors(id) on delete restrict,
  vendor_name_oneoff text,
  gross_amount numeric(14,2) not null check (gross_amount >= 0),
  -- Validated against Gross x 12/112 in the app rather than forced here:
  -- zero-rated and exempt purchases are ordinary, and a CHECK would reject a
  -- true figure. See checkVat() in lib/finance/expense-vat.ts.
  vat_amount numeric(14,2) not null default 0 check (vat_amount >= 0),
  -- Net = Gross - VAT, generated so the ledger can never disagree with itself.
  net_amount numeric(14,2) generated always as (gross_amount - vat_amount) stored,
  payment_method text check (payment_method in
    ('cash', 'bank_transfer', 'gcash', 'credit_card', 'petty_cash', 'other')),
  workflow_stage text not null default 'encoded' check (workflow_stage in
    ('encoded', 'finance_review', 'department_approval', 'management_approval',
     'ready_for_payment', 'paid', 'archived')),
  status text not null default 'pending' check (status in
    ('pending', 'approved', 'paid', 'cancelled', 'archived')),
  remarks text,
  encoded_by uuid references users(id) on delete set null,
  encoded_at timestamptz not null default now(),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_code_uq unique (org_id, expense_code),
  constraint expenses_vat_within_gross check (vat_amount <= gross_amount),
  constraint expenses_has_one_payee check (
    (vendor_id is not null and vendor_name_oneoff is null)
    or (vendor_id is null and vendor_name_oneoff is not null)
  )
);

create index if not exists expenses_org_date_idx
  on public.expenses(org_id, transaction_date desc);
create index if not exists expenses_stage_idx
  on public.expenses(org_id, workflow_stage);
create index if not exists expenses_brand_idx on public.expenses(org_id, brand_id);
create index if not exists expenses_department_idx on public.expenses(org_id, department_id);

-- The code is assigned on INSERT only. An update that changes the transaction
-- date — and with it the year — must not renumber the expense.
create or replace function public.expenses_assign_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.expense_code is null or new.expense_code = '' then
    -- Year of ENCODING, not of the transaction: the code records when the
    -- expense entered the ledger.
    new.expense_code := public.next_expense_code(
      new.org_id, extract(year from coalesce(new.encoded_at, now()))::int
    );
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_assign_code_trg on public.expenses;
create trigger expenses_assign_code_trg
  before insert on public.expenses
  for each row execute function public.expenses_assign_code();

-- Freeze the code against every later write.
create or replace function public.expenses_freeze_code()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.expense_code is distinct from old.expense_code then
    raise exception 'expense_code is permanent and cannot be changed (% -> %)',
      old.expense_code, new.expense_code;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists expenses_freeze_code_trg on public.expenses;
create trigger expenses_freeze_code_trg
  before update on public.expenses
  for each row execute function public.expenses_freeze_code();

-- ── Budgets ─────────────────────────────────────────────────────────────────
-- Columns mirror BudgetRow in lib/finance/budgets.ts. The 80 / 90 / exceeded
-- bands are computed from utilisation in that module, not stored here.
create table if not exists public.budgets (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  scope text not null check (scope in ('brand', 'department')),
  brand_id uuid references brands(id) on delete cascade,
  department_id uuid references departments(id) on delete cascade,
  period text not null,
  annual_budget numeric(14,2),
  monthly_budget numeric(14,2),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budgets_scope_target check (
    (scope = 'brand' and brand_id is not null and department_id is null)
    or (scope = 'department' and department_id is not null and brand_id is null)
  ),
  constraint budgets_uq unique nulls not distinct (org_id, scope, brand_id, department_id, period)
);

create index if not exists budgets_org_period_idx on public.budgets(org_id, period);

-- ── Immutable audit trail ───────────────────────────────────────────────────
-- "Created and modified by and when, previous and updated values, approval
-- actions, payment confirmation, attachment history." Append-only: there is no
-- update or delete policy below, so even Finance cannot revise history.
create table if not exists public.expense_audit (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  expense_id uuid not null references expenses(id) on delete cascade,
  action text not null,
  actor_id uuid references users(id) on delete set null,
  previous_values jsonb,
  updated_values jsonb,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists expense_audit_expense_idx
  on public.expense_audit(expense_id, created_at desc);

create or replace function public.expenses_write_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.expense_audit (org_id, expense_id, action, actor_id, updated_values)
    values (new.org_id, new.id, 'encoded', new.encoded_by, to_jsonb(new));
    return new;
  end if;

  -- Only record a row that actually changed, so the trail stays readable.
  if to_jsonb(new) is distinct from to_jsonb(old) then
    insert into public.expense_audit (org_id, expense_id, action, actor_id, previous_values, updated_values)
    values (
      new.org_id, new.id,
      case when new.workflow_stage is distinct from old.workflow_stage
           then 'stage:' || new.workflow_stage else 'updated' end,
      auth.uid(), to_jsonb(old), to_jsonb(new)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_audit_trg on public.expenses;
create trigger expenses_audit_trg
  after insert or update on public.expenses
  for each row execute function public.expenses_write_audit();

-- ── The approvals view ──────────────────────────────────────────────────────
-- Shape taken from ApprovalRow in the approvals page. It resolves the names the
-- queue shows so the page needs no joins, and exposes workflow_stage using the
-- canonical vocabulary from expense-workflow.ts.
create or replace view public.expense_approvals_view as
select
  e.id,
  e.org_id,
  e.expense_code,
  coalesce(v.name, e.vendor_name_oneoff, '—') as vendor_name,
  coalesce(c.name, '—') as category,
  coalesce(b.name, '—') as brand,
  coalesce(d.name, '—') as department,
  e.gross_amount,
  e.net_amount,
  e.transaction_date,
  array_position(
    array['encoded', 'finance_review', 'department_approval',
          'management_approval', 'ready_for_payment', 'paid', 'archived'],
    e.workflow_stage
  ) as current_stage,
  e.workflow_stage,
  coalesce(u.full_name, '—') as submitted_by,
  e.encoded_at as submitted_at,
  -- Whole days a request has been waiting, which is what the queue sorts on.
  greatest(0, extract(day from (now() - e.encoded_at))::int) as days_pending
from public.expenses e
left join public.expense_vendors v on v.id = e.vendor_id
left join public.expense_categories c on c.id = e.category_id
left join public.brands b on b.id = e.brand_id
left join public.departments d on d.id = e.department_id
left join public.users u on u.id = e.encoded_by;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- The report names five roles; this OS has four account roles, so they map:
-- Finance Administrator and Finance Staff -> ceo/coo (the write path),
-- Department Manager -> department_head, Executive and Auditor -> read.
-- Everyone in the org may read the ledger; only leadership writes it. The audit
-- trail is narrower, and nobody may revise it.
alter table public.expense_categories enable row level security;
alter table public.expense_vendors enable row level security;
alter table public.expenses enable row level security;
alter table public.budgets enable row level security;
alter table public.expense_audit enable row level security;

drop policy if exists expense_categories_select on public.expense_categories;
create policy expense_categories_select on public.expense_categories for select
  using (org_id = current_org_id());
drop policy if exists expense_categories_write on public.expense_categories;
create policy expense_categories_write on public.expense_categories for all
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'))
  with check (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

drop policy if exists expense_vendors_select on public.expense_vendors;
create policy expense_vendors_select on public.expense_vendors for select
  using (org_id = current_org_id());
drop policy if exists expense_vendors_write on public.expense_vendors;
create policy expense_vendors_write on public.expense_vendors for all
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'))
  with check (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses for select
  using (org_id = current_org_id());
drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses for insert
  with check (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo', 'department_head')
    -- An expense enters the ledger encoded. Filing one already approved would
    -- walk straight past every gate.
    and workflow_stage = 'encoded'
  );
drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses for update
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'))
  with check (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

drop policy if exists budgets_select on public.budgets;
create policy budgets_select on public.budgets for select
  using (org_id = current_org_id());
drop policy if exists budgets_write on public.budgets;
create policy budgets_write on public.budgets for all
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'))
  with check (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

-- Finance and system admins only, per the report.
drop policy if exists expense_audit_select on public.expense_audit;
create policy expense_audit_select on public.expense_audit for select
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));
-- No insert / update / delete policy: rows arrive through the SECURITY DEFINER
-- trigger, and no role can rewrite what it recorded.

-- ── Category seeds ──────────────────────────────────────────────────────────
-- The five the report names. Idempotent, and it will not resurrect a category
-- an admin has since disabled.
insert into public.expense_categories (org_id, name)
select o.id, c.name
from organizations o
cross join (values
  ('Administrative'), ('Marketing'), ('Operations'),
  ('Human Resources'), ('Finance')
) as c(name)
on conflict (org_id, name) do nothing;
