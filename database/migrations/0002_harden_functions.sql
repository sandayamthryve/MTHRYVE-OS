-- Mthryve OS — Migration 0002: Harden SECURITY DEFINER helper functions
-- Pins search_path (prevents search_path injection on SECURITY DEFINER functions)
-- and restricts RPC exposure to the authenticated role only.
-- Addresses Supabase security advisor lints:
--   0011 function_search_path_mutable
--   0028 anon_security_definer_function_executable
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-06.

create or replace function public.current_org_id()
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select org_id from public.users where id = auth.uid();
$$;

create or replace function public.current_user_role()
returns public.user_role
language sql
security definer
stable
set search_path = ''
as $$
  select role from public.users where id = auth.uid();
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- RLS helpers only need to be callable by signed-in users (policy evaluation
-- runs as the querying role). Remove the default PUBLIC/anon grant so they are
-- not exposed as anonymous RPC endpoints.
revoke execute on function public.current_org_id() from public, anon;
revoke execute on function public.current_user_role() from public, anon;
grant execute on function public.current_org_id() to authenticated;
grant execute on function public.current_user_role() to authenticated;
