-- Migration 20260728010000 — metrics_snapshots ROLLUP support.
--
-- The daily department-health rollup writer (lib/metrics/rollup.ts, driven by the
-- GitHub Actions schedule that already holds AUTOMATION_API_KEY) folds metric_entries into
-- ONE metrics_snapshots row per (org_id, department_id, period). To make that
-- write idempotent — and to stamp provenance the same way the TikTok sync stamps
-- tiktok_shop_performance — this migration:
--
--   1. Adds `source` + `synced_at` (mirrors the TikTok landing tables): every row
--      the rollup writes carries source='rollup' and synced_at=<run time>, so a
--      human-entered row (source NULL) is always distinguishable from an automated
--      one and freshness is auditable.
--   2. De-duplicates the pre-existing (org, department, period) rows. Before today
--      nothing enforced one-row-per-period, so the org-level history accumulated
--      exact duplicates (e.g. three identical 2026-07-13 rows). We keep the newest
--      physical row per key and drop the rest, so the unique index can be created.
--   3. Adds a UNIQUE index on (org_id, department_id, period_start, period_end)
--      with NULLS NOT DISTINCT (Postgres 15+, this DB is 17) so the org-level rows
--      (department_id IS NULL) collapse to one per period too — a plain UNIQUE
--      would treat every NULL department_id as distinct and defeat the upsert. This
--      index is the arbiter the writer's ON CONFLICT targets.
--
-- Idempotent / re-runnable: IF NOT EXISTS on the columns and index, and the dedupe
-- is a no-op once the index exists.

-- 1. Provenance + freshness columns ------------------------------------------
alter table public.metrics_snapshots
  add column if not exists source text,
  add column if not exists synced_at timestamptz;

comment on column public.metrics_snapshots.source is
  'Origin of the row: ''rollup'' = written by the automated department-health rollup (lib/metrics/rollup.ts); NULL = human/manual or legacy import.';
comment on column public.metrics_snapshots.synced_at is
  'When the automated rollup last wrote/refreshed this row (Manila-agnostic UTC instant). NULL for manual rows.';

-- 2. Collapse pre-existing duplicates on the natural key ---------------------
-- Keep the physically-newest row (max ctid) per (org, department, period); NULL
-- department_id is compared with IS NOT DISTINCT FROM so org-level dupes collapse.
delete from public.metrics_snapshots a
using public.metrics_snapshots b
where a.ctid < b.ctid
  and a.org_id = b.org_id
  and a.department_id is not distinct from b.department_id
  and a.period_start = b.period_start
  and a.period_end = b.period_end;

-- 3. The idempotency arbiter --------------------------------------------------
create unique index if not exists metrics_snapshots_org_dept_period_uniq
  on public.metrics_snapshots (org_id, department_id, period_start, period_end)
  nulls not distinct;
