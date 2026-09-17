-- Migration 0015: per-brand × platform performance metrics
--
-- ⚠️ DEPRECATED FOR READS (PR 3, 2026-07-28) — DO NOT source any figure from this
-- table. Verified against the live DB, brand_platform_metrics disagreed with
-- tiktok_shop_performance on EVERY brand in BOTH directions — over-counting,
-- under-counting, and phantom revenue for a brand with zero real GMV — and its
-- writer (lib/tiktok/reconcile.ts) trails the live TikTok landing table by days.
-- Every GMV/commerce surface now reads public.tiktok_shop_performance through
-- lib/metrics/tiktok-live.ts (one source of truth: company == Σ brands by
-- construction). The table is intentionally NOT dropped — the reconcile/import
-- write path still lands rows for a future audit trail — but nothing new should
-- READ it. See docs/INTEGRATION_PLAN.md ("brand_platform_metrics — DEPRECATED
-- for reads") and lib/metrics/tiktok-live.ts.
--
-- The universal metric set (0009 metrics_snapshots) is department-level. This
-- adds a brand × platform × period fact table so the OS can hold true
-- commerce + ad data per brand per channel (TikTok Shop, Shopee, Meta/TikTok/
-- Google Ads). Populated two ways, tracked by `source`:
--   'import'  — canonical CSV/sheet the team fills (Shopee, and any platform
--               not yet auto-connected). See templates/brand_platform_import_template.csv
--   'windsor' — auto-pulled via Windsor.ai (Meta/TikTok/Google Ads, TikTok Shop)
--
-- NOTE: not yet applied to live as of authoring — apply + commit together.

create type platform_channel as enum (
  'tiktok_shop', 'shopee', 'lazada', 'meta_ads', 'tiktok_ads', 'google_ads', 'other'
);

create table public.brand_platform_metrics (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  brand_id            uuid not null references public.brands (id) on delete cascade,
  platform            platform_channel not null,
  period_start        date not null,
  period_end          date not null,
  -- commerce
  gmv                 numeric(14,2),
  orders              integer,
  units               integer,
  returns             integer,
  return_rate         numeric(6,4),
  fulfillment_errors  integer,
  -- advertising
  ad_spend            numeric(14,2),
  ad_revenue          numeric(14,2),
  roas                numeric(10,4),
  -- meta
  currency            text not null default 'PHP',
  source              text not null default 'import',  -- 'import' | 'windsor' | 'manual'
  extra               jsonb not null default '{}'::jsonb,
  imported_by         uuid references public.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint brand_platform_metrics_period_ck check (period_end >= period_start),
  -- one row per brand/platform/period/source so re-imports upsert cleanly
  constraint brand_platform_metrics_uq
    unique (org_id, brand_id, platform, period_start, period_end, source)
);

create index brand_platform_metrics_brand_idx   on public.brand_platform_metrics (brand_id);
create index brand_platform_metrics_period_idx  on public.brand_platform_metrics (period_start, period_end);
create index brand_platform_metrics_platform_idx on public.brand_platform_metrics (platform);

create trigger brand_platform_metrics_set_updated_at
  before update on public.brand_platform_metrics
  for each row execute function public.set_updated_at();

alter table public.brand_platform_metrics enable row level security;

-- Read: any member of the org (brand performance is org-wide visibility).
create policy brand_platform_metrics_select on public.brand_platform_metrics
  for select using (org_id = public.current_org_id());

-- Write: managers only (mirrors metrics entry RBAC from 0009/0010).
create policy brand_platform_metrics_insert on public.brand_platform_metrics
  for insert with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );

create policy brand_platform_metrics_update on public.brand_platform_metrics
  for update using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  ) with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );

create policy brand_platform_metrics_delete on public.brand_platform_metrics
  for delete using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );
