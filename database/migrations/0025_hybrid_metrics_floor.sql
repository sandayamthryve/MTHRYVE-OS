-- Migration 0025: Phase 1 — Hybrid Metrics Floor
--
-- A provenance-safe metrics system across ALL departments (E-Commerce, Live
-- Ops, Warehouse, Creatives, Affiliate). Every metric has a manual encoding
-- form NOW; a platform API is a validator layered on later. The two data
-- sources NEVER overwrite each other — manual_value and api_value are separate
-- columns, and each displayed number carries its origin.
--
-- Design rules honoured here:
--   * Manual and API values live in SEPARATE columns; neither clobbers the
--     other. Setting api_value is impossible from the client (enforced in the
--     API layer — this table just keeps the columns apart).
--   * Honest nulls — no value means NULL, never a fabricated 0.
--   * Thresholds are NOT duplicated. Green/amber/red bands already live in the
--     existing public.metric_targets table (joined on metric = metric_key at
--     read time). This migration adds NO threshold columns.
--   * RLS on both new tables; reuses current_org_id() / current_user_role().
--
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-15 (migration
-- `hybrid_metrics_floor`).
--
-- NOTE — table-name collision: this migration is idempotent
-- (`create table if not exists`), so if a differently-shaped metric_catalog /
-- metric_entries already exists it is a NO-OP for that table rather than
-- clobbering it. The authoritative Phase-1 shape is the one defined here
-- (department + note columns, origin allowing 'calculated', validation default
-- 'unvalidated'). On a clean migration lineage this creates exactly that. If a
-- parallel effort has created these table names with a different design, the two
-- schemas must be reconciled at the design level before this can take effect —
-- do NOT force-drop the other tables.

-- 1. metric_catalog: defines each metric ONCE (definition only — no thresholds,
--    no values).
create table if not exists public.metric_catalog (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations (id) on delete cascade,
  metric_key text not null,                 -- e.g. 'ecom.gmv', 'live.viewers'
  department text not null,                 -- 'ecommerce' | 'live_ops' | 'warehouse' | 'creatives' | 'affiliate'
  category text,                            -- 'sales' | 'traffic' | 'customer' | 'operational' | 'account_health'
  label text not null,
  unit text,                                -- 'currency' | 'count' | 'percent' | 'hours' | 'rating'
  lane text not null check (lane in ('auto', 'auto_possible', 'manual')),
  api_source text,                          -- nullable: 'tiktok_shop' | 'tiktok_settlement' | ...
  api_field text,                           -- nullable
  formula text,                             -- nullable: derived metric, e.g. 'ecom.gmv / ecom.orders'
  direction text not null default 'up' check (direction in ('up', 'down')),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, metric_key)
);

alter table public.metric_catalog enable row level security;

create policy metric_catalog_org_read on public.metric_catalog for select
  using (org_id = public.current_org_id());
create policy metric_catalog_leadership_write on public.metric_catalog for all
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo', 'department_head'))
  with check (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo', 'department_head'));

-- 2. metric_entries: one row per metric / brand / period. Manual and API kept
--    apart — variance_pct only computes when BOTH exist.
create table if not exists public.metric_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations (id) on delete cascade,
  metric_key text not null,
  department text not null,
  brand_id uuid references public.brands (id) on delete cascade,   -- null = shop/org-level metric
  period_start date not null,
  period_end date not null,
  manual_value numeric,                     -- the encoded floor
  api_value numeric,                        -- filled by sync later; NEVER overwrites manual_value
  origin text not null default 'manual' check (origin in ('manual', 'api', 'reconciled', 'calculated')),
  variance_pct numeric generated always as (
    case when manual_value is not null and api_value is not null and api_value <> 0
      then round(abs(manual_value - api_value) / abs(api_value) * 100, 2) end
  ) stored,
  validation_status text not null default 'unvalidated'
    check (validation_status in ('unvalidated', 'match', 'mismatch', 'overridden')),
  entered_by uuid default auth.uid(),
  approved_by uuid,
  approved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per metric/brand/period. brand_id null (shop/org-level) and brand_id
-- set are disjoint uniqueness domains — a partial index for each, since NULLs
-- don't collide in a plain unique constraint.
create unique index if not exists metric_entries_brand_uniq
  on public.metric_entries (org_id, metric_key, brand_id, period_start, period_end) where brand_id is not null;
create unique index if not exists metric_entries_shop_uniq
  on public.metric_entries (org_id, metric_key, period_start, period_end) where brand_id is null;
create index if not exists metric_entries_dept_period_idx
  on public.metric_entries (org_id, department, period_start, period_end);

alter table public.metric_entries enable row level security;

create policy metric_entries_org_read on public.metric_entries for select
  using (org_id = public.current_org_id());
create policy metric_entries_org_insert on public.metric_entries for insert
  with check (org_id = public.current_org_id());
create policy metric_entries_org_update on public.metric_entries for update
  using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());

-- 3. Guard: only leadership may set approved_by / approved_at. Also touches
--    updated_at on every update.
create or replace function public.guard_metric_entry_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then
    if coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '') not in ('ceo', 'coo', 'department_head')
       and public.current_user_role() not in ('ceo', 'coo', 'department_head') then
      raise exception 'Only leadership may approve metric entries';
    end if;
  end if;
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_guard_metric_entry_approval on public.metric_entries;
create trigger trg_guard_metric_entry_approval before update on public.metric_entries
  for each row execute function public.guard_metric_entry_approval();

-- 4. Auto-set validation_status when both values exist (mismatch threshold 5%).
--    'overridden' is a leadership decision and is never auto-changed.
create or replace function public.set_metric_validation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.manual_value is not null and new.api_value is not null then
    if new.validation_status <> 'overridden' then
      new.validation_status := case
        when abs(new.manual_value - new.api_value) / nullif(abs(new.api_value), 0) * 100 <= 5 then 'match'
        else 'mismatch' end;
    end if;
  else
    if new.validation_status <> 'overridden' then new.validation_status := 'unvalidated'; end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_set_metric_validation on public.metric_entries;
create trigger trg_set_metric_validation before insert or update on public.metric_entries
  for each row execute function public.set_metric_validation();

-- ============================================================================
-- SEED metric_catalog for every existing org.
--
-- Seeded via `select from organizations cross join defs` (not the column
-- default) because a migration has no auth context, so current_org_id() would
-- be NULL. `on conflict (org_id, metric_key) do nothing` makes this re-runnable
-- and skips any metric_key an org already has. lane reflects what the API can
-- deliver TODAY; everything still gets a manual form. sort_order comes from the
-- definition order within each department.
-- ============================================================================
with defs (metric_key, department, category, label, unit, lane, api_source, formula, direction, ord) as (values
  -- E-COMMERCE
  ('ecom.gmv',                 'ecommerce', 'sales',          'GMV',                    'currency', 'auto',          'tiktok_shop',        null,                  'up',   1),
  ('ecom.net_sales',           'ecommerce', 'sales',          'Net Sales',              'currency', 'auto',          'tiktok_settlement',  null,                  'up',   2),
  ('ecom.orders',              'ecommerce', 'sales',          'Orders',                 'count',    'auto',          'tiktok_shop',        null,                  'up',   3),
  ('ecom.units',               'ecommerce', 'sales',          'Units Sold',             'count',    'auto',          'tiktok_shop',        null,                  'up',   4),
  ('ecom.aov',                 'ecommerce', 'sales',          'Average Order Value',    'currency', 'auto',          null,                 'ecom.gmv / ecom.orders', 'up', 5),
  ('ecom.conversion',          'ecommerce', 'sales',          'Conversion Rate',        'percent',  'auto',          'tiktok_shop',        null,                  'up',   6),
  ('ecom.refund_rate',         'ecommerce', 'sales',          'Refund Rate',            'percent',  'auto',          'tiktok_settlement',  null,                  'down', 7),
  ('ecom.cancellation_rate',   'ecommerce', 'sales',          'Cancellation Rate',      'percent',  'auto_possible', null,                 null,                  'down', 8),
  ('ecom.return_rate',         'ecommerce', 'sales',          'Return Rate',            'percent',  'auto_possible', null,                 null,                  'down', 9),
  ('ecom.product_views',       'ecommerce', 'traffic',        'Product Views',          'count',    'auto',          'tiktok_shop',        null,                  'up',   10),
  ('ecom.store_visits',        'ecommerce', 'traffic',        'Store Visits',           'count',    'auto',          'tiktok_shop',        null,                  'up',   11),
  ('ecom.ctr',                 'ecommerce', 'traffic',        'Click-Through Rate',     'percent',  'manual',        null,                 null,                  'up',   12),
  ('ecom.product_impressions', 'ecommerce', 'traffic',        'Product Impressions',    'count',    'manual',        null,                 null,                  'up',   13),
  ('ecom.search_ranking',      'ecommerce', 'traffic',        'Search Ranking',         'count',    'manual',        null,                 null,                  'down', 14),
  ('ecom.new_customers',       'ecommerce', 'customer',       'New Customers',          'count',    'auto_possible', null,                 null,                  'up',   15),
  ('ecom.returning_customers', 'ecommerce', 'customer',       'Returning Customers',    'count',    'auto_possible', null,                 null,                  'up',   16),
  ('ecom.repeat_purchase_rate','ecommerce', 'customer',       'Repeat Purchase Rate',   'percent',  'auto_possible', null,                 null,                  'up',   17),
  ('ecom.fulfillment_rate',    'ecommerce', 'operational',    'Fulfillment Rate',       'percent',  'auto_possible', null,                 null,                  'up',   18),
  ('ecom.shipping_sla',        'ecommerce', 'operational',    'Shipping SLA',           'percent',  'auto_possible', null,                 null,                  'up',   19),
  ('ecom.processing_time',     'ecommerce', 'operational',    'Processing Time',        'hours',    'manual',        null,                 null,                  'down', 20),
  ('ecom.response_rate',       'ecommerce', 'operational',    'Response Rate',          'percent',  'manual',        null,                 null,                  'up',   21),
  ('ecom.chat_performance',    'ecommerce', 'operational',    'Chat Performance',       'percent',  'manual',        null,                 null,                  'up',   22),
  ('ecom.shop_rating',         'ecommerce', 'account_health', 'Shop Rating',            'rating',   'auto_possible', null,                 null,                  'up',   23),
  ('ecom.seller_score',        'ecommerce', 'account_health', 'Seller Score',           'count',    'manual',        null,                 null,                  'up',   24),
  ('ecom.violation_points',    'ecommerce', 'account_health', 'Violation Points',       'count',    'manual',        null,                 null,                  'down', 25),
  ('ecom.listing_health',      'ecommerce', 'account_health', 'Listing Health',         'percent',  'manual',        null,                 null,                  'up',   26),
  ('ecom.late_shipment_rate',  'ecommerce', 'account_health', 'Late Shipment Rate',     'percent',  'manual',        null,                 null,                  'down', 27),

  -- LIVE OPS
  ('live.hours',               'live_ops',  'operational',    'Live Hours',             'hours',    'auto',          null,                 null,                  'up',   1),
  ('live.gmv',                 'live_ops',  'sales',          'Live GMV',               'currency', 'auto_possible', null,                 null,                  'up',   2),
  ('live.gmvmax_roas',         'live_ops',  'sales',          'GMV Max ROAS',           'percent',  'manual',        null,                 null,                  'up',   3),
  ('live.viewers',             'live_ops',  'traffic',        'Viewers',                'count',    'manual',        null,                 null,                  'up',   4),
  ('live.impressions',         'live_ops',  'traffic',        'Impressions',            'count',    'manual',        null,                 null,                  'up',   5),
  ('live.ctr',                 'live_ops',  'traffic',        'Click-Through Rate',     'percent',  'manual',        null,                 null,                  'up',   6),
  ('live.ctor',                'live_ops',  'traffic',        'Click-to-Order Rate',    'percent',  'manual',        null,                 null,                  'up',   7),
  ('live.top_products',        'live_ops',  'sales',          'Top Products',           'count',    'auto_possible', null,                 null,                  'up',   8),
  ('live.violations',          'live_ops',  'account_health', 'Violations',             'count',    'manual',        null,                 null,                  'down', 9),

  -- WAREHOUSE & FULFILLMENT
  ('wh.orders',                'warehouse', 'operational',    'Orders',                 'count',    'auto',          null,                 null,                  'up',   1),
  ('wh.to_ship',               'warehouse', 'operational',    'To Ship',                'count',    'auto_possible', null,                 null,                  'up',   2),
  ('wh.shipped',               'warehouse', 'operational',    'Shipped',                'count',    'auto_possible', null,                 null,                  'up',   3),
  ('wh.completed',             'warehouse', 'operational',    'Completed',              'count',    'auto_possible', null,                 null,                  'up',   4),
  ('wh.pending',               'warehouse', 'operational',    'Pending',                'count',    'auto_possible', null,                 null,                  'up',   5),
  ('wh.cancelled',             'warehouse', 'operational',    'Cancelled',              'count',    'auto_possible', null,                 null,                  'down', 6),
  ('wh.failed_delivery',       'warehouse', 'operational',    'Failed Delivery',        'count',    'manual',        null,                 null,                  'down', 7),
  ('wh.dispatch_rate',         'warehouse', 'operational',    'Dispatch Rate',          'percent',  'auto_possible', null,                 null,                  'up',   8),
  ('wh.shipping_overdue',      'warehouse', 'operational',    'Shipping Overdue',       'count',    'manual',        null,                 null,                  'down', 9),
  ('wh.auto_cancel_24h',       'warehouse', 'operational',    'Auto-Cancel (24h)',      'count',    'manual',        null,                 null,                  'down', 10),
  ('wh.return_refund_requests','warehouse', 'operational',    'Return/Refund Requests', 'count',    'manual',        null,                 null,                  'down', 11),

  -- CREATIVES
  ('cr.video_views',           'creatives', 'traffic',        'Video Views',            'count',    'manual',        null,                 null,                  'up',   1),
  ('cr.video_impressions',     'creatives', 'traffic',        'Video Impressions',      'count',    'manual',        null,                 null,                  'up',   2),
  ('cr.ctr',                   'creatives', 'traffic',        'Click-Through Rate',     'percent',  'manual',        null,                 null,                  'up',   3),
  ('cr.ctor',                  'creatives', 'traffic',        'Click-to-Order Rate',    'percent',  'manual',        null,                 null,                  'up',   4),
  ('cr.cvr',                   'creatives', 'traffic',        'Conversion Rate',        'percent',  'manual',        null,                 null,                  'up',   5),
  ('cr.gmv_attributed',        'creatives', 'sales',          'GMV Attributed',         'currency', 'manual',        null,                 null,                  'up',   6),
  ('cr.video_attributed_sales','creatives', 'sales',          'Video Attributed Sales', 'currency', 'manual',        null,                 null,                  'up',   7),
  ('cr.gmvmax_ads',            'creatives', 'sales',          'GMV Max Ads',            'currency', 'auto_possible', null,                 null,                  'up',   8),

  -- AFFILIATE
  ('aff.creator_analytics',    'affiliate', 'customer',       'Creator Analytics',      'count',    'manual',        null,                 null,                  'up',   1),
  ('aff.sample_requests',      'affiliate', 'operational',    'Sample Requests',        'count',    'manual',        null,                 null,                  'up',   2),
  ('aff.sample_approvals',     'affiliate', 'operational',    'Sample Approvals',       'count',    'manual',        null,                 null,                  'up',   3),
  ('aff.videos_posted',        'affiliate', 'operational',    'Videos Posted',          'count',    'manual',        null,                 null,                  'up',   4),
  ('aff.video_attributed_sales','affiliate','sales',          'Video Attributed Sales', 'currency', 'manual',        null,                 null,                  'up',   5),
  ('aff.gmvmax_ads',           'affiliate', 'sales',          'GMV Max Ads',            'currency', 'auto_possible', null,                 null,                  'up',   6),
  ('aff.impressions',          'affiliate', 'traffic',        'Impressions',            'count',    'manual',        null,                 null,                  'up',   7),
  ('aff.views',                'affiliate', 'traffic',        'Views',                  'count',    'manual',        null,                 null,                  'up',   8),
  ('aff.ctr',                  'affiliate', 'traffic',        'Click-Through Rate',     'percent',  'manual',        null,                 null,                  'up',   9),
  ('aff.ctor',                 'affiliate', 'traffic',        'Click-to-Order Rate',    'percent',  'manual',        null,                 null,                  'up',   10),
  ('aff.cvr',                  'affiliate', 'traffic',        'Conversion Rate',        'percent',  'manual',        null,                 null,                  'up',   11),
  ('aff.gmv',                  'affiliate', 'sales',          'GMV',                    'currency', 'auto_possible', null,                 null,                  'up',   12)
)
insert into public.metric_catalog
  (org_id, metric_key, department, category, label, unit, lane, api_source, formula, direction, sort_order)
select o.id, d.metric_key, d.department, d.category, d.label, d.unit, d.lane, d.api_source, d.formula, d.direction, d.ord
from public.organizations o
cross join defs d
on conflict (org_id, metric_key) do nothing;
