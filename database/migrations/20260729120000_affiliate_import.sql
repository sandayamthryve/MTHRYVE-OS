-- Mthryve OS — Migration: Affiliate performance import (PR 14)
--
-- The data-layer backstops for ONE new importer added to the existing CSV/XLSX
-- Bulk Import tool (/imports): the Seller Center → Affiliate → Analytics export.
-- It REUSES the existing domain tables — creators and creator_posts — and adds
-- nothing new. This migration provides the three things that importer needs the
-- data layer to guarantee, and NOTHING else:
--
--   • creator_posts attribution columns — an affiliate export row is a piece of
--     creator content with its OWN attributed GMV / orders / commission. Those
--     had no home on creator_posts (which only carried post identity), so they
--     are added here as NULLABLE numerics: an unreported figure stays NULL and
--     renders an honest "—", never a fabricated 0. These are ATTRIBUTION, not
--     company revenue — see the column comments and PART C.
--
--   • creator_posts natural-key uniqueness — creator_posts had NO unique
--     constraint, so a bulk writer without one would duplicate a post on every
--     re-import. A UNIQUE index on (org_id, creator_id, post_url) — the stable
--     natural key of an affiliate content row — lets the importer UPSERT: a
--     re-imported file refreshes the same rows in place instead of duplicating
--     them. NULL post_url is nulls-distinct (Postgres default), so the manual
--     "log a post" path (which may leave post_url blank) is unaffected.
--
--   • import_batches entity_type — the audit CHECK is widened by one value so an
--     affiliate import writes the same immutable audit row every other importer
--     does. Additive: the four existing values are unchanged.
--
-- Additive and idempotent (add column / create index IF NOT EXISTS; the CHECK is
-- dropped and recreated as a strict superset). No existing creator or post data
-- is read or modified. creator_posts is empty at authoring time, so the UNIQUE
-- index builds with zero risk of a pre-existing duplicate.
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ============================================================
-- PART A — creator_posts attributed figures (nullable = honest "—").
-- gmv / commission are money in the creators' currency; orders is a count.
-- currency defaults to PHP to match tiktok_shop_performance / the org default.
-- ============================================================
alter table public.creator_posts add column if not exists gmv        numeric;
alter table public.creator_posts add column if not exists orders     integer;
alter table public.creator_posts add column if not exists commission numeric;
alter table public.creator_posts add column if not exists currency   text not null default 'PHP';

comment on column public.creator_posts.gmv is
  'ATTRIBUTED GMV for this piece of creator content, from the Seller Center Affiliate export. This is affiliate ATTRIBUTION, not company revenue — it is never summed into company GMV (that reads only tiktok_shop_performance). NULL = not reported (renders "—", never 0).';
comment on column public.creator_posts.commission is
  'Attributed affiliate commission for this content (creators currency). NULL = not reported (renders "—", never 0).';
comment on column public.creator_posts.orders is
  'Attributed order count for this content. NULL = not reported.';

-- ============================================================
-- PART B — the natural-key UNIQUE index the bulk upsert needs.
-- Full (non-partial) index so it can serve as the ON CONFLICT arbiter for the
-- importer's upsert on (org_id, creator_id, post_url). Rows with a NULL post_url
-- (the manual log-post path) are nulls-distinct and never collide.
-- ============================================================
create unique index if not exists creator_posts_org_creator_posturl_uniq
  on public.creator_posts (org_id, creator_id, post_url);

comment on index public.creator_posts_org_creator_posturl_uniq is
  'No two posts per creator may share a post_url within an org. The upsert key for the affiliate performance importer so a re-imported export refreshes posts in place instead of duplicating them. NULL post_url is nulls-distinct, so manually logged url-less posts are unaffected.';

-- ============================================================
-- PART C — widen import_batches.entity_type by one value (strict superset).
-- ============================================================
alter table public.import_batches drop constraint if exists import_batches_entity_type_check;
alter table public.import_batches add constraint import_batches_entity_type_check
  check (entity_type in ('products', 'creators', 'metric_entries', 'metrics_snapshots', 'affiliate_performance'));
