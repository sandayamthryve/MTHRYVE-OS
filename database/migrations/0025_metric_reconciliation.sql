-- Mthryve OS — Migration 0025: Metric catalog + entries (the manual metrics
-- FLOOR) and the API validation overlay on top of it.
--
-- TWO LAYERS, ONE ROW:
--   metric_entries holds BOTH the human-recorded number (manual_value, the
--   "floor") and the platform-API number (api_value, the "overlay"). The floor
--   is authoritative until a human reconciles; the overlay only ever validates
--   it. The DB computes variance_pct + validation_status from the two, so no
--   surface has to re-derive "do these agree?".
--
-- NON-NEGOTIABLE (D-…): the API sync writes api_value ONLY. It is STRUCTURALLY
--   impossible for the sync to touch manual_value because it writes exclusively
--   through public.apply_metric_api_value(), a SECURITY DEFINER function whose
--   body never assigns manual_value (it only ever inserts it as NULL). manual_
--   value changes only through the leadership manual-entry / override paths,
--   which run as the RLS user client.
--
-- A mismatch is surfaced to a human, never auto-resolved: 'overridden' is a
--   terminal human decision the validation trigger refuses to recompute away.
--
-- Applied to project otepdjhrawtqkzclaxbk together with this commit.

-- ─────────────────────────────────────────────────────────────────────────────
-- metric_catalog — the definition of each tracked metric for an org. `lane`
-- says whether the number is hand-entered ('manual'), auto-pullable now
-- ('auto'), or auto-pullable once a source lands ('auto_possible'). An auto lane
-- must name the source table (api_source) and column (api_field) the sync reads.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.metric_catalog (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  metric_key  text not null,
  label       text not null,
  department  text,                                  -- grouping for the Validation panel
  unit        text not null default 'number',        -- 'currency' | 'count' | 'rate' | 'number'
  lane        text not null default 'manual'
                check (lane in ('manual', 'auto', 'auto_possible')),
  api_source  text
                check (api_source in ('tiktok_shop', 'tiktok_settlement', 'product', 'ads', 'ratings')),
  api_field   text,                                  -- source column the sync pulls
  is_money    boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint metric_catalog_uq unique (org_id, metric_key),
  -- a manual metric names no source; an auto metric MUST name where its value
  -- comes from (this is what the sync filters on: lane in (auto,auto_possible)
  -- AND api_source is not null).
  constraint metric_catalog_api_ck check (
    (lane = 'manual' and api_source is null)
    or (lane in ('auto', 'auto_possible') and api_source is not null and api_field is not null)
  )
);

create index metric_catalog_org_idx on public.metric_catalog (org_id);

create trigger metric_catalog_set_updated_at
  before update on public.metric_catalog
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- metric_entries — one row per (org, metric, brand, period). manual_value is
-- the floor; api_value is the overlay; variance_pct + validation_status are
-- DERIVED by the trigger below. origin records how the row came to be:
--   'manual'     — a human recorded it, no API value yet
--   'api'        — the sync created it, no manual floor underneath
--   'reconciled' — both a manual floor and an API value are present
-- ─────────────────────────────────────────────────────────────────────────────
create table public.metric_entries (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations (id) on delete cascade,
  metric_key        text not null,
  brand_id          uuid references public.brands (id) on delete cascade,   -- NULL = org-level
  period_start      date not null,
  period_end        date not null,
  manual_value      numeric(18, 4),        -- the human floor; the SYNC NEVER writes this
  api_value         numeric(18, 4),        -- the platform overlay; written by the sync ONLY
  variance_pct      numeric(10, 2),        -- trigger-derived: (api - manual)/|manual| * 100
  validation_status text not null default 'pending'
                      check (validation_status in
                        ('pending', 'manual_only', 'api_only', 'match', 'mismatch', 'overridden')),
  origin            text not null default 'manual'
                      check (origin in ('manual', 'api', 'reconciled')),
  override_choice   text
                      check (override_choice in ('keep_manual', 'accept_api', 'override')),
  entered_by        uuid references public.users (id) on delete set null,
  approved_by       uuid references public.users (id) on delete set null,   -- who reconciled
  approved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint metric_entries_period_ck check (period_end >= period_start)
);

-- Natural-key uniqueness. brand_id NULL means org-level; Postgres treats NULLs
-- as distinct in a plain UNIQUE, which would let two org-level rows for the same
-- metric/period coexist — so key on a coalesced sentinel to force the collision
-- (and give the sync's read-or-insert a single row to find).
create unique index metric_entries_key_uq on public.metric_entries
  (org_id, metric_key,
   coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
   period_start, period_end);

create index metric_entries_status_idx on public.metric_entries (org_id, validation_status);
create index metric_entries_period_idx on public.metric_entries (period_start, period_end);

create trigger metric_entries_set_updated_at
  before update on public.metric_entries
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- The validation trigger — derives variance_pct + validation_status from the
-- two values on every write. This is the "DB already computes match/mismatch"
-- the overlay relies on. A human 'overridden' decision is terminal: the trigger
-- refuses to recompute the status away from it (but still refreshes variance so
-- the hover always shows the current gap).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.metric_entries_validate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  match_tol constant numeric := 1.0;   -- within ±1% of the manual floor counts as a match
begin
  -- Variance is only meaningful when both sides are real and the floor is non-zero.
  if new.manual_value is not null and new.api_value is not null and new.manual_value <> 0 then
    new.variance_pct := round(((new.api_value - new.manual_value) / abs(new.manual_value)) * 100, 2);
  else
    new.variance_pct := null;
  end if;

  -- Terminal human decision — never auto-resolve it back to match/mismatch.
  if new.validation_status = 'overridden' then
    return new;
  end if;

  if new.manual_value is null and new.api_value is null then
    new.validation_status := 'pending';
  elsif new.api_value is null then
    new.validation_status := 'manual_only';
  elsif new.manual_value is null then
    new.validation_status := 'api_only';
  elsif new.variance_pct is not null and abs(new.variance_pct) <= match_tol then
    new.validation_status := 'match';
  elsif new.variance_pct is null then
    -- both present but the floor is 0: only a 0 overlay agrees with a 0 floor.
    new.validation_status := case when new.api_value = 0 then 'match' else 'mismatch' end;
  else
    new.validation_status := 'mismatch';
  end if;

  return new;
end;
$$;

create trigger metric_entries_validate_biu
  before insert or update on public.metric_entries
  for each row execute function public.metric_entries_validate();

-- Only the trigger invokes this — no role should reach it over PostgREST RPC.
-- Supabase's default privileges grant EXECUTE to anon/authenticated on new
-- functions, so revoke from them EXPLICITLY (mirrors the 0003/0006/0013 posture
-- for trigger functions — revoking from PUBLIC alone is not enough).
revoke execute on function public.metric_entries_validate() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- apply_metric_api_value — the ONLY write path the sync uses. It sets api_value
-- (and origin) for an existing row, or inserts a new api-origin row with a NULL
-- manual floor. Because manual_value never appears on the left of an assignment
-- here, it is structurally impossible for the sync to overwrite the human floor,
-- even though the sync runs with the service-role key.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.apply_metric_api_value(
  p_org_id       uuid,
  p_metric_key   text,
  p_brand_id     uuid,
  p_period_start date,
  p_period_end   date,
  p_api_value    numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from public.metric_entries
   where org_id = p_org_id
     and metric_key = p_metric_key
     and coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(p_brand_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and period_start = p_period_start
     and period_end = p_period_end
   limit 1;

  if v_id is not null then
    -- A row exists (manual floor or a prior api pull). Set api_value in place;
    -- if a human floor sits underneath, the row is now 'reconciled'. NOTE:
    -- manual_value is deliberately absent from this UPDATE.
    update public.metric_entries
       set api_value = p_api_value,
           origin = case when manual_value is not null then 'reconciled' else 'api' end
     where id = v_id;
  else
    -- No floor to sit on — insert an api-origin row with a NULL manual floor.
    insert into public.metric_entries
      (org_id, metric_key, brand_id, period_start, period_end, api_value, manual_value, origin)
    values
      (p_org_id, p_metric_key, p_brand_id, p_period_start, p_period_end, p_api_value, null, 'api');
  end if;
end;
$$;

-- Server-only: the sync calls this with the service-role key. No client role
-- may invoke it directly. Revoke the default anon/authenticated grants too, not
-- just PUBLIC, then hand EXECUTE to service_role only.
revoke execute on function public.apply_metric_api_value(uuid, text, uuid, date, date, numeric) from public, anon, authenticated;
grant execute on function public.apply_metric_api_value(uuid, text, uuid, date, date, numeric) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — read across the org; manual entry, imports and overrides are leadership
-- writes through the user client. The sync bypasses RLS via the service-role
-- key AND is funnelled through apply_metric_api_value(), so it can only ever
-- move api_value.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.metric_catalog enable row level security;
alter table public.metric_entries enable row level security;

create policy metric_catalog_select on public.metric_catalog
  for select using (org_id = public.current_org_id());
create policy metric_catalog_insert on public.metric_catalog
  for insert with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );
create policy metric_catalog_update on public.metric_catalog
  for update using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  ) with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );
create policy metric_catalog_delete on public.metric_catalog
  for delete using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo')
  );

create policy metric_entries_select on public.metric_entries
  for select using (org_id = public.current_org_id());
create policy metric_entries_insert on public.metric_entries
  for insert with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );
create policy metric_entries_update on public.metric_entries
  for update using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  ) with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );
create policy metric_entries_delete on public.metric_entries
  for delete using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the catalog for every existing org. These are the auto / auto_possible
-- metrics the sync knows how to pull. Re-runnable (on conflict do nothing).
--   tiktok_shop        → tiktok_shop_performance (aggregated by org + period)
--   tiktok_settlement  → tiktok_settlements       (aggregated by org + period)
--   product/ads/ratings→ pulled only IF their source returns rows for the period
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.metric_catalog
  (org_id, metric_key, label, department, unit, lane, api_source, api_field, is_money, sort_order)
select o.id, v.metric_key, v.label, v.department, v.unit, v.lane, v.api_source, v.api_field, v.is_money, v.sort_order
from public.organizations o
cross join (values
  ('gmv',             'GMV',             'Commerce', 'currency', 'auto',          'tiktok_shop',       'gmv',             true,   10),
  ('orders',          'Orders',          'Commerce', 'count',    'auto',          'tiktok_shop',       'orders',          false,  20),
  ('units',           'Units sold',      'Commerce', 'count',    'auto',          'tiktok_shop',       'units',           false,  30),
  ('visitors',        'Visitors',        'Commerce', 'count',    'auto',          'tiktok_shop',       'visitors',        false,  40),
  ('page_views',      'Page views',      'Commerce', 'count',    'auto',          'tiktok_shop',       'page_views',      false,  50),
  ('conversion_rate', 'Conversion rate', 'Commerce', 'rate',     'auto',          'tiktok_shop',       'conversion_rate', false,  60),
  ('net_settlement',  'Net settlement',  'Finance',  'currency', 'auto',          'tiktok_settlement', 'net_amount',      true,   70),
  ('refunds',         'Refunds',         'Finance',  'currency', 'auto',          'tiktok_settlement', 'refund_amount',   true,   80),
  ('product_gmv',     'Product GMV',     'Commerce', 'currency', 'auto_possible', 'product',           'gmv',             true,   90),
  ('ad_spend',        'Ad spend',        'Marketing','currency', 'auto_possible', 'ads',               'cost',            true,  100),
  ('shop_rating',     'Shop rating',     'CX',       'rate',     'auto_possible', 'ratings',           'shop_rating',     false, 110)
) as v(metric_key, label, department, unit, lane, api_source, api_field, is_money, sort_order)
on conflict (org_id, metric_key) do nothing;
