-- Mthryve OS — Migration 0006: Remove RPC exposure from the signup trigger fn.
-- handle_new_user only ever fires from the AFTER INSERT trigger on auth.users
-- (table-owner context, no EXECUTE grant needed). Revoke from all API roles so
-- it isn't reachable as an anon/authenticated RPC endpoint (advisor 0028/0029).
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-07.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
