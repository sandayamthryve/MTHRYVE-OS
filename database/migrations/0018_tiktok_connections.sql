-- Migration 0018: TikTok Shop Partner token vault (documents the provisioned
-- tables)
--
-- public.tiktok_connections holds one OAuth connection per (org, seller) for the
-- TikTok Shop Partner API (Settings → "Connect TikTok Shop"). It stores the
-- access + refresh tokens obtained via the Partner authorization flow.
-- public.tiktok_shops holds the shops authorized under each connection.
--
-- SECURITY MODEL — a LOCKED vault (identical to canva_connections, 0017):
--   • RLS is ENABLED and there is deliberately NO policy. With RLS on and no
--     policy, the anon/user (authenticated) clients can read/write NOTHING.
--   • Both tables are reachable ONLY through the service-role key
--     (SUPABASE_SERVICE_ROLE_KEY), used exclusively server-side in
--     lib/tiktok/vault.ts. Tokens never touch the browser.
--   • See SECURITY.md, DECISIONS.md D-006.
--
-- This file is idempotent and documents tables that already exist on the live
-- project — apply is a no-op there, but the repo now carries the schema + the
-- security intent as source of truth. It does NOT alter RLS or the existing
-- vault schema.

create table if not exists public.tiktok_connections (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.organizations (id) on delete cascade,
  -- One connection per seller within an org. The OAuth callback upserts on
  -- (org_id, open_id) so reconnecting the same seller overwrites in place.
  open_id                   text not null,
  seller_name               text,
  region                    text,
  access_token              text,
  refresh_token             text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  granted_scopes            text[],
  connected_by              uuid references public.users (id) on delete set null,
  status                    text not null default 'active',
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (org_id, open_id)
);

create table if not exists public.tiktok_shops (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  connection_id  uuid not null references public.tiktok_connections (id) on delete cascade,
  brand_id       uuid references public.brands (id) on delete set null,
  -- One row per shop within an org. The callback upserts on (org_id, shop_id).
  shop_id        text not null,
  shop_cipher    text,
  shop_name      text,
  region         text,
  status         text not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (org_id, shop_id)
);

-- Lock both: RLS on, no policy → only the service role can touch them.
alter table public.tiktok_connections enable row level security;
alter table public.tiktok_shops enable row level security;

comment on table public.tiktok_connections is
  'TikTok Shop Partner OAuth token vault, one row per (org, seller open_id). '
  'RLS on with NO policy — service-role access only. Never expose tokens to the '
  'browser.';
comment on table public.tiktok_shops is
  'Shops authorized under a tiktok_connections row. RLS on with NO policy — '
  'service-role access only.';
