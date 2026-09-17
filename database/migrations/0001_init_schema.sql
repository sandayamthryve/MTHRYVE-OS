-- Mthryve OS — Migration 0001: Foundation schema
-- Covers: tenants, organizations, departments, brands, users, roles-as-data
-- Applies RLS to every table per BUGS.md R-001 (multi-tenant data isolation).
--
-- Run via Supabase CLI: supabase db push
-- or paste into Supabase SQL editor for initial setup.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "uuid-ossp";

-- ============================================================
-- Tenants (future-proofs multi-tenancy — see DECISIONS.md D-002)
-- ============================================================
create table tenants (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  plan text not null default 'internal',
  brand_theme jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Organizations
-- ============================================================
create table organizations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Users (extends Supabase auth.users — one row per authenticated person)
-- ============================================================
create type user_role as enum ('ceo', 'coo', 'department_head', 'team_member');

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  department_id uuid, -- FK added after departments table exists (circular dependency below)
  full_name text not null,
  email text not null unique,
  role user_role not null default 'team_member',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Departments
-- ============================================================
create table departments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  lead_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Now that departments exists, wire the FK from users
alter table users
  add constraint users_department_id_fkey
  foreign key (department_id) references departments(id) on delete set null;

-- ============================================================
-- Brands
-- ============================================================
create table brands (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  platform_focus text[] not null default '{}',
  gmv_share numeric(5, 4), -- e.g. 0.7000 for ~70%
  status text not null default 'active', -- 'active' | 'inactive'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Helper function: current user's org_id
-- Used by every RLS policy below so scoping logic lives in one place.
-- ============================================================
create or replace function current_org_id()
returns uuid
language sql
security definer
stable
as $$
  select org_id from users where id = auth.uid();
$$;

create or replace function current_user_role()
returns user_role
language sql
security definer
stable
as $$
  select role from users where id = auth.uid();
$$;

-- ============================================================
-- Row-Level Security
-- ============================================================
alter table tenants enable row level security;
alter table organizations enable row level security;
alter table users enable row level security;
alter table departments enable row level security;
alter table brands enable row level security;

-- Tenants: only visible via the org relationship, no direct tenant listing
-- for non-CEO/COO roles.
create policy "tenants_select_own"
  on tenants for select
  using (
    id in (select tenant_id from organizations where id = current_org_id())
  );

-- Organizations: a user can only see their own org.
create policy "organizations_select_own"
  on organizations for select
  using (id = current_org_id());

-- Users: everyone in an org can see everyone else in the same org
-- (needed for assignment dropdowns, @mentions, etc.). Writing to other
-- users' rows is restricted to CEO/COO/department head of that department.
create policy "users_select_same_org"
  on users for select
  using (org_id = current_org_id());

create policy "users_update_self"
  on users for update
  using (id = auth.uid());

create policy "users_update_as_admin"
  on users for update
  using (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo')
  );

-- Departments: visible to everyone in the org (needed for nav/filtering);
-- see Milestone 1 for write-side department-head-only edit restrictions.
create policy "departments_select_same_org"
  on departments for select
  using (org_id = current_org_id());

create policy "departments_write_as_admin"
  on departments for insert
  with check (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

create policy "departments_update_as_admin"
  on departments for update
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

-- Brands: same pattern as departments.
create policy "brands_select_same_org"
  on brands for select
  using (org_id = current_org_id());

create policy "brands_write_as_admin"
  on brands for insert
  with check (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

create policy "brands_update_as_admin"
  on brands for update
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));

-- ============================================================
-- updated_at auto-touch trigger (applied to every table with the column)
-- ============================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tenants_set_updated_at before update on tenants
  for each row execute function set_updated_at();
create trigger organizations_set_updated_at before update on organizations
  for each row execute function set_updated_at();
create trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();
create trigger departments_set_updated_at before update on departments
  for each row execute function set_updated_at();
create trigger brands_set_updated_at before update on brands
  for each row execute function set_updated_at();

-- ============================================================
-- Seed: real Mthryve org structure (from AUDIT_ALL_BRANDS.xlsx integration)
-- Safe to re-run: uses do-block guards so it won't duplicate on re-apply.
-- ============================================================
do $$
declare
  v_tenant_id uuid;
  v_org_id uuid;
begin
  insert into tenants (name, plan) values ('Mthryve Marketing Inc.', 'internal')
    returning id into v_tenant_id;

  insert into organizations (tenant_id, name) values (v_tenant_id, 'Mthryve Marketing Inc.')
    returning id into v_org_id;

  insert into departments (org_id, name) values
    (v_org_id, 'Live Operations'),
    (v_org_id, 'Creative'),
    (v_org_id, 'Affiliate Marketing'),
    (v_org_id, 'Business Development'),
    (v_org_id, 'E-Commerce Ops'),
    (v_org_id, 'HR & Admin'),
    (v_org_id, 'Warehouse & Fulfillment');

  insert into brands (org_id, name, gmv_share, status) values
    (v_org_id, 'FML (Industrial/Tarpaulin)', 0.7000, 'active'),
    (v_org_id, 'Alianna''s Choice', null, 'active'),
    (v_org_id, 'Namiroseus Main', null, 'active'),
    (v_org_id, 'Crayola Philippines', null, 'active'),
    (v_org_id, 'Basic City', null, 'active'),
    (v_org_id, 'Liao Philippines', null, 'active'),
    (v_org_id, 'Standard Philippines', null, 'active'),
    (v_org_id, 'Vitachums', null, 'active'),
    (v_org_id, 'Star 360', null, 'inactive'),
    (v_org_id, 'Amazing Pharma Corporation', null, 'active');
end $$;
