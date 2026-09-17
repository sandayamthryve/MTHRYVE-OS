-- 0024_tcve_realtime.sql
-- Tony Cognitive Visualization Engine (TCVE), phase 1 — live updates.
--
-- Enable Supabase Realtime replication on the two high-signal events the graph
-- animates in v1: a NEW approval request (action_requests INSERT) and a task
-- state change / completion (tasks UPDATE). No schema, column, or RLS change —
-- this only adds the tables to the `supabase_realtime` publication so authed
-- browser clients receive change events. Realtime STILL enforces RLS: a client
-- only receives rows its policies already allow it to SELECT, so org-scoping and
-- role gating are unchanged. Idempotent: skips a table already in the publication.
--
-- To reverse: `alter publication supabase_realtime drop table public.<t>;`

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'action_requests'
  ) then
    execute 'alter publication supabase_realtime add table public.action_requests';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    execute 'alter publication supabase_realtime add table public.tasks';
  end if;
end $$;
