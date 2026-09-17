-- Mthryve OS — Anomaly-monitoring verification (PASTE 4.3 Part D)
-- Proves the signal tables exist with the right RLS posture AND that the anomaly
-- monitor's detection math fires on a SEEDED spike. Run against a live project
-- (Supabase SQL editor or MCP execute_sql). The seed runs inside a transaction
-- that ROLLS BACK, so it never leaves test rows behind.
--
-- The detector itself is TypeScript (lib/security/anomaly.ts); this script
-- mirrors its thresholds in SQL so a DBA can confirm the same rows the app would
-- flag. Defaults mirrored here: window = 60 min, floors = spend ₱500 /
-- mass-read 120 / failed-login 5 / rls-denial 10 / export 20.

-- 1) Structural guarantees ----------------------------------------------------
-- 1a) The three tables exist.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('ai_usage_log', 'security_events', 'security_anomalies')
order by table_name;   -- expect all three

-- 1b) RLS is enabled on all three.
select c.relname, c.relrowsecurity   -- expect relrowsecurity = true for each
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('ai_usage_log', 'security_events', 'security_anomalies')
order by c.relname;

-- 1c) Sensitive reads are leadership-only (ceo/coo) — no broad org read.
select c.relname, pol.polname,
  case pol.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                  when 'w' then 'UPDATE' when 'd' then 'DELETE' else pol.polcmd::text end as cmd
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('ai_usage_log', 'security_events', 'security_anomalies')
order by c.relname, cmd;

-- 2) Behavioural: seed a spike and confirm the detection math flags it ---------
begin;

-- Use any existing org for the test.
with org as (select id from public.organizations limit 1)

-- 2a) Seed a SPEND + MASS-READ spike: 150 AI calls in the last 30 minutes,
--     ₱20 each = ₱3000 (well over the ₱500 floor and the 120-call floor).
insert into public.ai_usage_log (org_id, agent, model, input_tokens, output_tokens, est_cost_php, created_at)
select org.id, 'tony', 'claude-opus-4-8', 1000, 1000, 20,
       now() - (g || ' minutes')::interval
from org, generate_series(0, 149) as g
where g < 30;   -- 30 distinct minutes, but we want 150 rows → expand below

-- (Expand to 150 rows across the last 30 min.)
insert into public.ai_usage_log (org_id, agent, model, input_tokens, output_tokens, est_cost_php, created_at)
select (select id from public.organizations limit 1), 'tony', 'claude-opus-4-8', 1000, 1000, 20,
       now() - ((random() * 29)::int || ' minutes')::interval
from generate_series(1, 150);

-- 2b) Seed a FAILED-LOGIN burst (12 in the window > floor 5) and an RLS-denial
--     surge (15 > floor 10) and an export spike (25 > floor 20).
insert into public.security_events (org_id, event_type, severity, created_at)
select (select id from public.organizations limit 1), 'failed_login', 'warning',
       now() - ((random() * 30)::int || ' minutes')::interval
from generate_series(1, 12);

insert into public.security_events (org_id, event_type, severity, created_at)
select (select id from public.organizations limit 1), 'rls_denial', 'warning',
       now() - ((random() * 30)::int || ' minutes')::interval
from generate_series(1, 15);

insert into public.security_events (org_id, event_type, severity, created_at)
select (select id from public.organizations limit 1), 'data_export', 'info',
       now() - ((random() * 30)::int || ' minutes')::interval
from generate_series(1, 25);

-- 2c) Recompute the recent-window metrics and compare to the floors. Each row
--     should read FLAG = true (the monitor would raise this anomaly).
with org as (select id from public.organizations limit 1),
recent as (
  select
    (select coalesce(sum(est_cost_php), 0) from public.ai_usage_log
       where org_id = (select id from org) and created_at >= now() - interval '60 minutes') as spend_php,
    (select count(*) from public.ai_usage_log
       where org_id = (select id from org) and created_at >= now() - interval '60 minutes') as reads,
    (select count(*) from public.security_events
       where org_id = (select id from org) and event_type = 'failed_login' and created_at >= now() - interval '60 minutes') as failed_logins,
    (select count(*) from public.security_events
       where org_id = (select id from org) and event_type = 'rls_denial' and created_at >= now() - interval '60 minutes') as rls_denials,
    (select count(*) from public.security_events
       where org_id = (select id from org) and event_type = 'data_export' and created_at >= now() - interval '60 minutes') as exports
)
select
  spend_php,      spend_php     > 500 as spend_spike_flag,        -- expect true
  reads,          reads         > 120 as mass_reads_flag,         -- expect true
  failed_logins,  failed_logins >= 5  as failed_login_burst_flag, -- expect true
  rls_denials,    rls_denials   >= 10 as rls_denial_surge_flag,   -- expect true
  exports,        exports       >= 20 as unusual_export_flag      -- expect true
from recent;

-- Leave no test data behind.
rollback;
