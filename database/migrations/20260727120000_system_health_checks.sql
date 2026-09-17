-- Mthryve OS — Migration 20260727120000: System Health Checks (Phase 0.4)
--
-- The heartbeat ledger for the production synthetic monitor. Auto-promote is ON,
-- so production needs its own verification independent of CI: a Vercel Cron hits
-- /api/monitor/auth-health every 5 minutes, fetches the live /login screen WITHOUT
-- following redirects, and records the result here.
--
--   Healthy   = 200 + the sign-in form marker present.
--   Unhealthy = any 3xx (the redirect-loop signature), any 429 (rate limiter
--               gating the login screen), a non-200, or a missing form marker.
--
-- This is the class of failure that 307-redirect-looped production /login for
-- ~2 weeks while the CEO acted as the test suite. This table is the record that
-- the heartbeat actually ran and what it saw.
--
-- GOVERNING RULES (mirror the rest of the OS — see 20260717020000 security_monitoring):
--   1. Standard stack + RLS. Reuses current_org_id() / current_user_role() and
--      set_updated_at(). The monitor writes with the SERVICE ROLE (bypasses RLS),
--      exactly like the anomaly detector, so there is no client INSERT policy —
--      this closes the door on client-side inserts.
--   2. Reads are LEADERSHIP-only (ceo/coo) — the same authority that reads
--      security_events / security_anomalies / audit_logs.
--   3. Additive only. Nothing here executes or blocks anything; it observes and
--      is read by the OS UI + alerting.

-- ── system_health_checks: one row per synthetic probe ────────────────────────
create table if not exists public.system_health_checks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.current_org_id()
                   references public.organizations(id) on delete cascade,
  -- The probe kind. Extensible; today the auth heartbeat writes 'auth_login'.
  check_type     text not null default 'auth_login',
  status         text not null check (status in ('healthy', 'unhealthy')),
  -- The observed HTTP status of the probed screen (e.g. 200, 307, 429). Null if
  -- the fetch itself threw (network error / timeout).
  http_status    integer,
  latency_ms     integer,
  -- Human-readable reason a check was classed unhealthy (e.g.
  -- 'redirect (307) — loop signature', '429 rate-limited', 'missing sign-in marker').
  -- Null when healthy.
  failure_reason text,
  target_url     text,
  detail         jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists system_health_checks_org_time_idx
  on public.system_health_checks (org_id, created_at desc);
create index if not exists system_health_checks_org_type_status_time_idx
  on public.system_health_checks (org_id, check_type, status, created_at desc);

drop trigger if exists system_health_checks_set_updated_at on public.system_health_checks;
create trigger system_health_checks_set_updated_at before update on public.system_health_checks
  for each row execute function public.set_updated_at();

-- ── Row-Level Security ───────────────────────────────────────────────────────
alter table public.system_health_checks enable row level security;

-- Leadership READ only (the heartbeat board). The monitor INSERTS with the
-- service role, so — like security_anomalies — no client insert policy exists.
drop policy if exists system_health_checks_select on public.system_health_checks;
create policy system_health_checks_select on public.system_health_checks for select
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo'));
