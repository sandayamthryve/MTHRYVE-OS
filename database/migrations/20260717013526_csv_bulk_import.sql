-- Mthryve OS — Migration: CSV Bulk Import
--
-- The audit + dedup backstops for the CSV Bulk Import tool (Import UI at
-- /imports). The importers themselves (products, creators, historical metrics)
-- REUSE the existing domain tables — products + stock_levels, creators,
-- metric_entries, metrics_snapshots — and add nothing to them. This migration
-- provides three things the tool needs the data layer to guarantee:
--
--   • import_batches   — one immutable audit row per committed import (who / when
--                        / file / row counts + the invalid-row error report as
--                        jsonb). Append-only, like stock_movements / product_
--                        history: written once at commit, never updated or
--                        deleted by clients.
--   • creators dedup   — partial unique indexes on email / phone / handle, the
--                        SAME defense-in-depth pattern as brands_org_active_name_
--                        uniq (0027). The importer blocks duplicates in preview;
--                        these make a duplicate impossible at the data layer even
--                        via a race or a future code path. products already has
--                        its backstop (products_org_id_brand_id_sku_key), so no
--                        products index is added here.
--   • dedup precondition — one exact-duplicate creator (a test row inserted
--                        twice seconds apart, no child references) is removed so
--                        the creators unique indexes can be created. Mirrors the
--                        0027 precondition where an empty duplicate brand was
--                        deleted ahead of the index.
--
-- Standard stack + RLS. Reuses current_org_id() / current_user_role() /
-- current_user_team() from 0001 / 0002 / 0025 (all confirmed present).
--
-- Additive and idempotent (create ... if not exists, drop-then-create policies,
-- guarded delete) — no existing product/creator/metric data is touched beyond
-- the single documented duplicate below.
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ============================================================
-- PART A — Dedup precondition for the creators unique indexes.
-- The known duplicate is an exact copy of a prospect creator (same org, name,
-- email, phone, handle, platform) inserted ~11s apart during testing. The newer
-- row has NO child rows in creator_posts / affiliate_deals / outreach_activities,
-- so dropping it loses nothing. Guarded by the full fingerprint + a NOT EXISTS
-- child-reference check so this is a safe no-op on any DB where the row is
-- absent or has since gained references.
-- ============================================================
delete from public.creators c
where c.id = '6174ae94-e78e-4d38-b614-d940251e4cbf'
  and lower(c.email) = 'albertjhonmorales@gmail.com'
  and not exists (select 1 from public.creator_posts p where p.creator_id = c.id)
  and not exists (select 1 from public.affiliate_deals d where d.creator_id = c.id)
  and not exists (select 1 from public.outreach_activities o where o.creator_id = c.id);

-- ============================================================
-- PART B — import_batches: one audit row per committed import.
-- entity_type names which importer ran. The *_rows counters reconcile:
--   total_rows = valid_rows (imported + could-not-import) + duplicate_rows +
--   invalid_rows, with imported_rows the count actually written. error_report
--   carries the invalid + duplicate rows (line, reason, raw values) so the audit
--   IS the downloadable error report's source of truth — nothing is dropped
--   silently.
-- ============================================================
create table if not exists public.import_batches (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  imported_by    uuid default auth.uid() references public.users(id) on delete set null,
  entity_type    text not null
                   check (entity_type in ('products', 'creators', 'metric_entries', 'metrics_snapshots')),
  file_name      text,
  file_size_bytes integer,
  total_rows     integer not null default 0,
  valid_rows     integer not null default 0,
  imported_rows  integer not null default 0,
  duplicate_rows integer not null default 0,
  invalid_rows   integer not null default 0,
  error_report   jsonb not null default '[]'::jsonb,
  notes          text,
  created_at     timestamptz not null default now()
);

create index if not exists import_batches_org_created_idx
  on public.import_batches(org_id, created_at desc);
create index if not exists import_batches_entity_idx
  on public.import_batches(org_id, entity_type, created_at desc);

comment on table public.import_batches is
  'Immutable audit trail for CSV bulk imports: who/when/file/row counts + the invalid-row error report (jsonb). Append-only — written once at commit.';
comment on column public.import_batches.error_report is
  'The rows that did NOT import (invalid + blocked duplicates) with their line number and reason. Source of the downloadable error report so nothing is dropped silently.';

-- ============================================================
-- PART C — creators dedup backstops (the brands_org_active_name_uniq pattern).
-- One partial unique index per contact identity. Case- and whitespace-folded so
-- "A@X.com " and "a@x.com" collide. Predicate excludes NULL/blank so creators
-- with no email (or no phone, or no handle) never collide on the missing value.
-- Handle is scoped by platform (the same @name on TikTok vs IG is two accounts).
-- ============================================================
create unique index if not exists creators_org_email_uniq
  on public.creators (org_id, lower(btrim(email)))
  where email is not null and btrim(email) <> '';

create unique index if not exists creators_org_phone_uniq
  on public.creators (org_id, btrim(phone))
  where phone is not null and btrim(phone) <> '';

create unique index if not exists creators_org_handle_uniq
  on public.creators (org_id, platform, lower(btrim(handle)))
  where handle is not null and btrim(handle) <> '';

comment on index public.creators_org_email_uniq is
  'No two creators per org may share a case/space-folded email. Backstop for the CSV Bulk Import creator dedup.';
comment on index public.creators_org_phone_uniq is
  'No two creators per org may share a trimmed phone. Backstop for the CSV Bulk Import creator dedup.';
comment on index public.creators_org_handle_uniq is
  'No two creators per org may share a case/space-folded handle on the same platform. Backstop for the CSV Bulk Import creator dedup.';

-- ============================================================
-- PART D — RLS on import_batches. Org-wide read (any member can review the
-- import history); insert restricted to leadership OR an owning team (Warehouse
-- for products, Business Development / Affiliate for creators) — the union of
-- the domains the tool can write. No update/delete policy: the audit is
-- append-only and tamper-resistant by construction.
-- ============================================================
alter table public.import_batches enable row level security;

drop policy if exists import_batches_select on public.import_batches;
drop policy if exists import_batches_insert on public.import_batches;

create policy import_batches_select on public.import_batches for select
  using (org_id = public.current_org_id());

create policy import_batches_insert on public.import_batches for insert
  with check (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or coalesce(public.current_user_team(), '') ilike '%warehouse%'
      or lower(coalesce(public.current_user_team(), '')) in ('business development', 'affiliate marketing')
    )
  );
