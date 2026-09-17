-- Mthryve OS — Migration: products (org_id, brand_id, sku) NULLS NOT DISTINCT
--
-- The product master's duplicate guard is the UNIQUE constraint
-- products_org_id_brand_id_sku_key on (org_id, brand_id, sku). Under Postgres'
-- default NULLS DISTINCT rule, two rows with brand_id = NULL are treated as
-- DISTINCT even when org_id + sku match — so a product imported with no brand had
-- NO duplicate protection, and re-uploading the same file created a second copy.
-- The importer now REFUSES to write a null brand (lib/import/engine.resolve
-- ProductBrands), and this migration closes the data-layer hole too: recreate the
-- constraint with NULLS NOT DISTINCT so a future null brand_id can never silently
-- duplicate a (org_id, sku).
--
-- SAFETY (verified on project otepdjhrawtqkzclaxbk, 2026-07-29):
--   • Backfill first: all 104 existing products already carry a non-null brand_id
--     (Liao Philippines) — 0 rows with brand_id NULL.
--   • Verify 0 conflicts: no (org_id, brand_id, sku) group has >1 row, so the
--     recreate cannot fail on a pre-existing duplicate. NULLS NOT DISTINCT only
--     tightens the rule (it can reject MORE, never fewer, than the current index),
--     and with zero null brand_ids it changes nothing about today's rows.
--
-- Additive and idempotent: the DO block is a no-op once the constraint already
-- carries NULLS NOT DISTINCT, so re-applying is safe. No column, RLS, or data
-- change — only the constraint definition is tightened.
--
-- Applied to project otepdjhrawtqkzclaxbk.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_org_id_brand_id_sku_key'
      and pg_get_constraintdef(oid) ilike '%nulls not distinct%'
  ) then
    alter table public.products drop constraint if exists products_org_id_brand_id_sku_key;
    alter table public.products
      add constraint products_org_id_brand_id_sku_key
      unique nulls not distinct (org_id, brand_id, sku);
  end if;
end $$;

comment on constraint products_org_id_brand_id_sku_key on public.products is
  'One product per (org, brand, sku). NULLS NOT DISTINCT so a null brand_id can never silently duplicate a (org, sku) — the importer additionally refuses to write a null brand at all.';
