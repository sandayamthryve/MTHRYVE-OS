-- Mthryve OS — Migration 0003: Remove RPC exposure from the trigger function.
-- set_updated_at is only ever invoked by BEFORE UPDATE triggers, which run in
-- the table-owner context and do not require an EXECUTE grant. Revoke from all
-- API roles so it is not reachable as an anonymous or authenticated RPC endpoint.
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-06.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
