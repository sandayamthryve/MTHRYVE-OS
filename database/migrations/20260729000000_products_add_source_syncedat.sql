-- Mthryve OS — Migration: products.source + products.synced_at (additive)
-- PR 11 (Warehouse Intake · Phase 1). `products` is the identity master and is
-- currently empty; the TikTok Product-API writer (lib/tiktok/products.ts) fills
-- it so Logi/warehouse has SKUs to render. This migration only adds provenance
-- columns the writer needs — no new table, no RLS change, no touch to the
-- movement-driven stock ledger. Both columns are NULLABLE so existing/manual
-- rows are unaffected. Idempotent via IF NOT EXISTS, so re-applying is a no-op.
-- Applied to project otepdjhrawtqkzclaxbk.

alter table public.products
  add column if not exists source     text,
  add column if not exists synced_at  timestamptz;

comment on column public.products.source    is 'Provenance of the row, e.g. tiktok_api | manual | csv_import';
comment on column public.products.synced_at is 'Last time an automated source wrote this row; null for manual rows';

-- Speeds up idempotent re-sync scans that filter on source. Non-unique, additive.
create index if not exists products_source_idx on public.products (source);
