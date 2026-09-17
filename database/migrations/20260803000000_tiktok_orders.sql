-- Mthryve OS — Migration 20260803000000: TikTok individual orders landing table
--
-- WHY. TikTok App Review requires the backend to hold real store order data —
-- specifically a genuine TikTok order ID (an 18-digit number starting 57/58).
-- Until now the daily TikTok sync stored ONLY aggregates: per-day GMV/orders/
-- units in tiktok_shop_performance and marketplace_orders_daily. No individual
-- order ID was persisted anywhere, so there was nothing to show the reviewer.
-- This migration adds the ONE thing that was missing — a per-order landing row —
-- and nothing else.
--
-- WHAT. public.tiktok_orders: one row per real TikTok order, keyed by the
-- store's own order_id. Filled by the EXISTING daily orders sync (lib/tiktok/
-- sync.ts · syncOrders), which already paginates every in-window order; it now
-- also folds each order into this table via an idempotent upsert on
-- (org_id, order_id). Re-running a day (or a backfill) refreshes rows in place
-- instead of duplicating them. No customer PII is stored — order_id, status,
-- money total, currency and the order's create time only. Buyer name/address/
-- phone are never read or written, exactly as the aggregate path already
-- guarantees.
--
-- SHAPE mirrors its sibling landing tables (tiktok_shop_performance /
-- tiktok_settlements): shop_id is the TikTok TEXT shop id, brand_id is the
-- nullable brands FK, currency is text. amount is the per-order money total.
--
-- SECURITY. Same posture as the other automated landing tables and the
-- synthetic-monitor ledger (system_health_checks): RLS on, an org-scoped SELECT
-- policy so any member of the org may READ their org's rows, and NO client
-- INSERT/UPDATE/DELETE policy — the sync writes with the SERVICE ROLE (which
-- bypasses RLS), so there is deliberately no client write path. The page that
-- surfaces these rows (/tiktok-orders) adds a department route gate on top
-- (leadership + E-Commerce Ops); RLS is the row floor, that gate is the door.
--
-- Additive and idempotent (create table / index / policy IF NOT EXISTS or
-- drop-then-create). No existing table is read or modified.
-- Applied to project otepdjhrawtqkzclaxbk.

-- ── tiktok_orders: one row per real TikTok Shop order ────────────────────────
create table if not exists public.tiktok_orders (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null default public.current_org_id()
                      references public.organizations(id) on delete cascade,
  -- The TikTok TEXT shop id (matches tiktok_shop_performance.shop_id /
  -- tiktok_settlements.shop_id), NOT the marketplace_shops UUID.
  shop_id           text not null,
  -- Nullable brand FK, mirroring the sibling landing tables.
  brand_id          uuid references public.brands(id) on delete set null,
  -- The store's own order identifier — the value TikTok App Review checks
  -- (an 18-digit number starting 57 or 58). Text, because it is an opaque id.
  order_id          text not null,
  -- Order lifecycle status as reported by TikTok (e.g. UNPAID, AWAITING_SHIPMENT,
  -- COMPLETED, CANCELLED). Nullable — an unreported status renders an honest "—".
  status            text,
  -- Per-order money total (payment total, or the summed line total as fallback),
  -- in `currency`. Nullable — never fabricated to 0.
  amount            numeric(14,2),
  currency          text,
  -- When the order was created on TikTok (the shop's create_time), as an instant.
  order_created_at  timestamptz,
  -- When this row was last written by the sync.
  synced_at         timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  -- The idempotent upsert key: one row per order within an org.
  constraint tiktok_orders_org_order_uq unique (org_id, order_id)
);

comment on table public.tiktok_orders is
  'One row per real TikTok Shop order, filled by the daily orders sync (lib/tiktok/sync.ts) via idempotent upsert on (org_id, order_id). Holds the genuine store order_id required by TikTok App Review. PII-free: order id / status / money total / currency / create time only.';
comment on column public.tiktok_orders.order_id is
  'The TikTok store order identifier (18-digit, starts 57/58). Upsert key with org_id.';
comment on column public.tiktok_orders.amount is
  'Per-order money total in `currency`. NULL = not reported (renders "—", never 0).';

-- Newest-first pagination for the /tiktok-orders page, scoped per org and shop.
create index if not exists tiktok_orders_org_created_idx
  on public.tiktok_orders (org_id, order_created_at desc);
create index if not exists tiktok_orders_org_shop_created_idx
  on public.tiktok_orders (org_id, shop_id, order_created_at desc);
-- Covering index for the brand_id FK (on delete set null) — keeps the FK check /
-- cascade from a sequential scan and clears the unindexed-foreign-key advisor.
create index if not exists tiktok_orders_brand_idx
  on public.tiktok_orders (brand_id);

-- ── Row-Level Security ───────────────────────────────────────────────────────
alter table public.tiktok_orders enable row level security;

-- Read: any member of the org may read their org's orders (the page's
-- requireDepartment gate narrows WHO reaches the surface). Mirrors the org-scoped
-- select the other landing tables use.
drop policy if exists tiktok_orders_select on public.tiktok_orders;
create policy tiktok_orders_select on public.tiktok_orders for select
  using (org_id = public.current_org_id());

-- No client INSERT/UPDATE/DELETE policy: the sync writes with the service role,
-- which bypasses RLS. This keeps the table write-closed to every client session
-- (same posture as system_health_checks / security_anomalies).
