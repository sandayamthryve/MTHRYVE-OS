-- Mthryve OS — Migration 0025: Client Ownership Split
--
-- One client record, two lenses:
--   • Business Development OWNS the client relationship (single source of truth).
--   • Commerce Ops READS a live reference to it (no second editable copy).
--
-- Canonical client/account table = public.brands. `brands` is the top-level
-- client entity every operational table already references by brand_id
-- (brand_source_breakdown, brand_initiatives, brand_platform_metrics, campaigns,
-- client_contracts, contract_scope_items). There is NO separate account table —
-- brands IS the account — and no relationship field is duplicated on any
-- Commerce-Ops-side table (they carry only operational columns + a brand_id FK),
-- so no data-migration/backfill is required to de-duplicate. This migration:
--   1) adds the relationship fields the owner (Business Development) edits, onto
--      the canonical table only (additive — no existing data touched);
--   2) restricts write on the canonical table to leadership OR the Business
--      Development team, leaving org-wide read intact;
--   3) leaves every operational table's team-writable policy UNCHANGED.
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ============================================================
-- 1) Relationship fields on the canonical client table.
-- Additive only (add column if not exists) — no populated column is dropped or
-- rewritten, so no client data is lost. These are the single home for each fact.
-- ============================================================
alter table public.brands add column if not exists legal_name text;
alter table public.brands add column if not exists account_tier text;
alter table public.brands add column if not exists onboarding_status text not null default 'active';
alter table public.brands add column if not exists primary_contact_name text;
alter table public.brands add column if not exists primary_contact_email text;
alter table public.brands add column if not exists primary_contact_phone text;

comment on column public.brands.legal_name is 'Legal / registered company name. Owned + edited only in Business Development.';
comment on column public.brands.account_tier is 'Account tier (e.g. strategic/growth/standard). Business Development owns this.';
comment on column public.brands.onboarding_status is 'Onboarding lifecycle status. Business Development owns this.';

-- ============================================================
-- 2) RLS helper: current user's team_assignment.
-- Mirrors current_org_id() / current_user_role() from 0001/0002 — SECURITY
-- DEFINER, pinned search_path, callable only by the authenticated role (policy
-- evaluation runs as the querying role; not exposed as an anon RPC endpoint).
-- ============================================================
create or replace function public.current_user_team()
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select team_assignment from public.users where id = auth.uid();
$$;

revoke execute on function public.current_user_team() from public, anon;
grant execute on function public.current_user_team() to authenticated;

-- ============================================================
-- 3) Canonical client table RLS: org read (unchanged); write restricted to
-- leadership (ceo/coo/department_head) OR users whose team_assignment is
-- Business Development. Everyone else keeps SELECT only.
-- ============================================================
-- Predicate reused across insert/update/delete. Case-insensitive team match so
-- 'Business Development' / 'business development' both authorize.
drop policy if exists brands_write_as_admin on public.brands;   -- was: insert, ceo/coo only
drop policy if exists brands_update_as_admin on public.brands;  -- was: update, ceo/coo only

create policy brands_insert_owner on public.brands for insert
  with check (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or lower(coalesce(public.current_user_team(), '')) = 'business development'
    )
  );

create policy brands_update_owner on public.brands for update
  using (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or lower(coalesce(public.current_user_team(), '')) = 'business development'
    )
  )
  with check (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or lower(coalesce(public.current_user_team(), '')) = 'business development'
    )
  );

create policy brands_delete_owner on public.brands for delete
  using (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or lower(coalesce(public.current_user_team(), '')) = 'business development'
    )
  );

-- ============================================================
-- 4) Operational tables (sources, initiatives, metrics, campaigns) are the
-- e-commerce team's own work and STAY team-writable. Intentionally NOT touched
-- here:
--   brand_source_breakdown  (bsb_write:  org members)
--   brand_initiatives       (bi_write:   org members)
--   brand_platform_metrics  (managers — unchanged)
--   campaigns               (insert/update: org members)
-- Left as-is so Commerce Ops stays fully writable for its own operational data.
-- ============================================================
