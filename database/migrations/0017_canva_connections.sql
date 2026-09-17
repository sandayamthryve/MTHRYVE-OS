-- Migration 0017: Canva Connect token vault (documents the provisioned table)
--
-- public.canva_connections holds one OAuth connection per org for the Canva
-- Connect API (Content Calendar → "Connect Canva" / "Create in Canva"). It
-- stores the access + refresh tokens obtained via OAuth 2.0 + PKCE.
--
-- SECURITY MODEL — a LOCKED vault:
--   • RLS is ENABLED and there is deliberately NO policy. With RLS on and no
--     policy, the anon/user (authenticated) clients can read/write NOTHING.
--   • The table is reachable ONLY through the service-role key
--     (SUPABASE_SERVICE_ROLE_KEY), used exclusively server-side in
--     lib/canva/vault.ts. Tokens never touch the browser.
--   • This mirrors how tokens must never be exposed to end users (see
--     SECURITY.md, DECISIONS.md D-006).
--
-- This file is idempotent and documents a table that already exists on the
-- live project — apply is a no-op there, but the repo now carries the schema +
-- the security intent as source of truth.

create table if not exists public.canva_connections (
  id                uuid primary key default gen_random_uuid(),
  -- One connection per org. unique org_id is what the OAuth callback upserts
  -- on (on conflict org_id) so reconnecting overwrites in place.
  org_id            uuid not null unique references public.organizations (id) on delete cascade,
  connected_by      uuid references public.users (id) on delete set null,
  access_token      text not null,
  refresh_token     text,
  token_expires_at  timestamptz,
  scope             text,
  canva_user_id     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Lock it: RLS on, no policy → only the service role can touch it.
alter table public.canva_connections enable row level security;

comment on table public.canva_connections is
  'Canva Connect OAuth token vault, one row per org. RLS on with NO policy — '
  'service-role access only. Never expose tokens to the browser.';
