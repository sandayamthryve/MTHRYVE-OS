-- Mthryve OS — Migration 0026: Warehouse Stock Core
--
-- The Warehouse module's own domain tables, built ON TOP of the existing
-- product catalogue. It REUSES public.products (the SKU master) and
-- public.product_metrics (trailing sales/rating signals) and adds the three
-- facts the module owns, each in ONE home:
--
--   • stock_levels     — on-hand / reserved / available / damaged / in-transit,
--                        one row per product. `available_stock` is a STORED
--                        generated column (current − reserved, floored at 0) so
--                        it can never drift from its inputs.
--   • stock_movements  — the append-only movement ledger (stock in/out,
--                        adjustments, manual corrections, returns, transfers)
--                        with the responsible personnel and a timestamp.
--   • product_history  — the Product Master audit trail. A trigger on products
--                        UPDATE records who changed what, when, as a jsonb diff.
--
-- Dashboard KPIs DERIVE from these tables at read time (see lib/warehouse) —
-- nothing is re-encoded into metric_entries or product_metrics. Honest nulls:
-- a product with no stock_levels row reads "—", never 0.
--
-- Standard stack + RLS: org-wide read; the Warehouse team and leadership write.
-- Reuses current_org_id() / current_user_role() / current_user_team() from
-- 0001 / 0002 / 0025 (all confirmed present on the project).
--
-- Additive and idempotent (add column / table / policy IF NOT EXISTS, or
-- drop-then-create for policies) — no existing product data is touched.
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ============================================================
-- PART A.1 — Extend the product master (additive, all nullable).
-- brand_id, category, status, reorder_point already exist on products.
-- ============================================================
alter table public.products add column if not exists variant text;
alter table public.products add column if not exists barcode text;
alter table public.products add column if not exists warehouse_location text;
alter table public.products add column if not exists cost numeric;
alter table public.products add column if not exists selling_price numeric;

comment on column public.products.variant is 'Optional product variant (size/colour/pack). Warehouse-owned.';
comment on column public.products.barcode is 'Scannable barcode / GTIN. Warehouse-owned; unique per product in practice, not enforced.';
comment on column public.products.warehouse_location is 'Physical bin / shelf location in the warehouse.';
comment on column public.products.cost is 'Landed unit cost (PHP). Drives margin; distinct from unit_value.';
comment on column public.products.selling_price is 'List selling price (PHP).';

-- ============================================================
-- PART A.2 — stock_levels: the single home for on-hand quantities.
-- One row per product. available_stock is generated + stored so the sellable
-- figure is always current − reserved (never negative) with no app math.
-- ============================================================
create table if not exists public.stock_levels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  current_stock integer not null default 0,
  reserved_stock integer not null default 0,
  available_stock integer generated always as (greatest(current_stock - reserved_stock, 0)) stored,
  damaged_stock integer not null default 0,
  in_transit integer not null default 0,
  reorder_level integer,
  updated_at timestamptz not null default now(),
  unique (product_id)
);

create index if not exists stock_levels_org_idx on public.stock_levels(org_id);
create index if not exists stock_levels_brand_idx on public.stock_levels(brand_id);

comment on table public.stock_levels is 'One home per product for on-hand/reserved/available/damaged/in-transit. Dashboard KPIs derive from here.';
comment on column public.stock_levels.available_stock is 'Generated: greatest(current_stock - reserved_stock, 0). Cannot drift from its inputs.';

drop trigger if exists trg_stock_levels_updated_at on public.stock_levels;
create trigger trg_stock_levels_updated_at before update on public.stock_levels
  for each row execute function public.set_updated_at();

-- ============================================================
-- PART A.3 — stock_movements: the append-only inventory ledger.
-- ============================================================
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  brand_id uuid references public.brands(id) on delete set null,
  movement_type text not null
    check (movement_type in ('stock_in','stock_out','adjustment','manual_correction','return','transfer')),
  qty integer not null,
  note text,
  personnel_id uuid default auth.uid() references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_org_created_idx on public.stock_movements(org_id, created_at desc);
create index if not exists stock_movements_product_idx on public.stock_movements(product_id, created_at desc);
create index if not exists stock_movements_type_idx on public.stock_movements(org_id, movement_type, created_at desc);

comment on table public.stock_movements is 'Append-only movement ledger. qty is signed by the app per movement_type; the discrepancy alert compares the ledger net against stock_levels.current_stock.';

-- ============================================================
-- PART A.4 — product_history: the Product Master audit trail.
-- A trigger on products UPDATE records the diff (who / when / what changed).
-- ============================================================
create table if not exists public.product_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  user_id uuid default auth.uid() references public.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  changes jsonb not null default '{}'
);

create index if not exists product_history_product_idx on public.product_history(product_id, changed_at desc);
create index if not exists product_history_org_idx on public.product_history(org_id, changed_at desc);

comment on table public.product_history is 'Immutable Product Master audit trail. Written only by the products UPDATE trigger.';

-- The diff trigger: on every products UPDATE, record the columns that actually
-- changed as { column: { old, new } }. Housekeeping columns are ignored so an
-- updated_at-only bump never logs a no-op edit. SECURITY DEFINER so the insert
-- lands regardless of the caller's RLS (product_history has no client-write
-- policy — the audit is append-only and tamper-resistant by construction).
create or replace function public.products_history_diff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_ignore text[] := array['updated_at', 'created_at', 'id', 'org_id', 'created_by'];
begin
  for v_key in select jsonb_object_keys(v_new) loop
    if v_key = any (v_ignore) then
      continue;
    end if;
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key)
      );
    end if;
  end loop;

  if v_changes <> '{}'::jsonb then
    insert into public.product_history (org_id, product_id, user_id, changes)
    values (new.org_id, new.id, auth.uid(), v_changes);
  end if;

  return new;
end;
$$;

revoke execute on function public.products_history_diff() from public, anon, authenticated;

drop trigger if exists trg_products_history_diff on public.products;
create trigger trg_products_history_diff after update on public.products
  for each row execute function public.products_history_diff();

-- ============================================================
-- PART A.5 — RLS. Org-wide read; Warehouse team + leadership write.
-- The write predicate mirrors the client-ownership pattern from 0025: leadership
-- (ceo/coo/department_head) OR a member whose team_assignment names Warehouse.
-- ============================================================

-- Products: keep org-wide read; tighten write to Warehouse team + leadership.
alter table public.products enable row level security;
drop policy if exists products_org_write on public.products;  -- was: any org member
drop policy if exists products_write on public.products;
drop policy if exists products_org_select on public.products;

create policy products_org_select on public.products for select
  using (org_id = public.current_org_id());

create policy products_write on public.products for all
  using (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or coalesce(public.current_user_team(), '') ilike '%warehouse%'
    )
  )
  with check (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or coalesce(public.current_user_team(), '') ilike '%warehouse%'
    )
  );

-- stock_levels
alter table public.stock_levels enable row level security;
drop policy if exists stock_levels_select on public.stock_levels;
drop policy if exists stock_levels_write on public.stock_levels;

create policy stock_levels_select on public.stock_levels for select
  using (org_id = public.current_org_id());

create policy stock_levels_write on public.stock_levels for all
  using (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or coalesce(public.current_user_team(), '') ilike '%warehouse%'
    )
  )
  with check (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or coalesce(public.current_user_team(), '') ilike '%warehouse%'
    )
  );

-- stock_movements: org read; Warehouse team + leadership INSERT (append-only).
-- No update/delete policy — the ledger is immutable to clients.
alter table public.stock_movements enable row level security;
drop policy if exists stock_movements_select on public.stock_movements;
drop policy if exists stock_movements_insert on public.stock_movements;

create policy stock_movements_select on public.stock_movements for select
  using (org_id = public.current_org_id());

create policy stock_movements_insert on public.stock_movements for insert
  with check (
    org_id = public.current_org_id()
    and (
      public.current_user_role() in ('ceo', 'coo', 'department_head')
      or coalesce(public.current_user_team(), '') ilike '%warehouse%'
    )
  );

-- product_history: org read only. Writes come exclusively from the definer
-- trigger, so there is deliberately no client insert/update/delete policy.
alter table public.product_history enable row level security;
drop policy if exists product_history_select on public.product_history;

create policy product_history_select on public.product_history for select
  using (org_id = public.current_org_id());
