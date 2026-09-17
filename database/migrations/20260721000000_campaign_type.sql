-- Mthryve OS — Migration 20260721000000: Campaign type
--
-- Adds a `type` classifier to the existing public.campaigns table so one table
-- carries all four kinds of campaign — a plain campaign, a promotion, a mission,
-- and an affiliate campaign — and each area (Commerce vs Affiliate) simply reads
-- the SAME table filtered by type. This is the DB half of the Type selector /
-- Type filter added to the Campaigns UI and the creator→campaign link.
--
-- GOVERNING RULES (mirror the rest of the OS):
--   1. Additive + idempotent — only ADD a column, a default, a CHECK, and a
--      one-time backfill. Every existing row stays valid. Safe to run twice.
--   2. The existing status CHECK is NOT touched. RLS is NOT touched — the row
--      policies already cover the table (and therefore the new column); a new
--      scalar column needs no policy change.
--   3. Honest default — a campaign with no explicit type is a plain 'campaign',
--      which is exactly what every pre-existing row is, so the backfill is a
--      faithful classification, not an invented value.

-- ── campaigns.type: the four-way classifier ───────────────────────────────────
alter table public.campaigns
  add column if not exists type text;

-- Backfill any pre-existing / NULL rows to the honest default BEFORE the CHECK is
-- (re)applied, so the constraint can never reject an existing row.
update public.campaigns
  set type = 'campaign'
  where type is null;

-- Default for future inserts that omit the column.
alter table public.campaigns
  alter column type set default 'campaign';

-- Constrain to the four allowed kinds. Idempotent (drop + re-add) so re-running
-- the migration re-asserts the exact set without erroring on an existing one.
alter table public.campaigns
  drop constraint if exists campaigns_type_check;

alter table public.campaigns
  add constraint campaigns_type_check
  check (type in ('campaign', 'promotion', 'mission', 'affiliate'));

-- Fast filtering of the list by (org, type) — the Type filter/tabs and the
-- Affiliate-area "type = affiliate" section both narrow on this.
create index if not exists ix_campaigns_org_type
  on public.campaigns (org_id, type);
