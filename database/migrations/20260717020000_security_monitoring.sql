-- Mthryve OS — Migration 20260717020000: Security Monitoring (PASTE 4.3 Part D)
--
-- The signal store + alert ledger the anomaly monitor reads and writes:
--   • ai_usage_log      — one row per AI call (agent + model + tokens + ₱ est),
--                         the substrate for spend-spike and mass-read detection.
--   • security_events   — failed logins, RLS denials, data exports, mass reads,
--                         injection flags, output redactions — the raw signal feed.
--   • security_anomalies— alerts the monitor RAISES (one per org+kind+window),
--                         each carrying the metric, threshold and runbook link.
--
-- GOVERNING RULES (mirror the rest of the OS):
--   1. Standard stack + RLS. Reuses current_org_id() / current_user_role() and
--      set_updated_at(). Signals are append-only from the app; the monitor writes
--      with the service role (bypasses RLS) like the Automation Radar detector.
--   2. Fresh timestamp version (ordinals 0017–0027 are taken) so the runner
--      applies it.
--   3. Reads are LEADERSHIP-only where the data is sensitive (usage cost, the
--      security feed, the alerts) — the same authority that reads audit_logs.
--   4. Nothing here executes or blocks anything; it observes + alerts.
--
-- Applied to project otepdjhrawtqkzclaxbk (migration `security_monitoring`).

-- ── ai_usage_log: per-call AI usage + estimated spend ────────────────────────
create table if not exists public.ai_usage_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id()
                  references public.organizations(id) on delete cascade,
  user_id       uuid references public.users(id) on delete set null,
  agent         text not null,                 -- 'tony' | 'vesper' | 'csi' | ...
  model         text,                          -- claude-haiku-4-5 / sonnet-5 / opus-4-8
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  est_cost_php  numeric not null default 0,    -- estimate only; billing lives elsewhere
  meta          jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists ai_usage_log_org_time_idx
  on public.ai_usage_log (org_id, created_at desc);
create index if not exists ai_usage_log_org_user_time_idx
  on public.ai_usage_log (org_id, user_id, created_at desc);

-- ── security_events: the raw security signal feed ────────────────────────────
create table if not exists public.security_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id()
                references public.organizations(id) on delete cascade,
  user_id     uuid references public.users(id) on delete set null,
  event_type  text not null check (event_type in (
                'failed_login', 'rls_denial', 'data_export',
                'mass_read', 'injection_flagged', 'output_redacted')),
  severity    text not null default 'warning'
                check (severity in ('info', 'warning', 'critical')),
  subject     text,                            -- attempted identity when no session (e.g. login email)
  ip          text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists security_events_org_type_time_idx
  on public.security_events (org_id, event_type, created_at desc);
create index if not exists security_events_org_time_idx
  on public.security_events (org_id, created_at desc);

-- ── security_anomalies: the alert ledger ─────────────────────────────────────
create table if not exists public.security_anomalies (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.current_org_id()
                 references public.organizations(id) on delete cascade,
  kind         text not null check (kind in (
                 'spend_spike', 'mass_data_reads', 'failed_login_burst',
                 'rls_denial_surge', 'unusual_export_volume')),
  severity     text not null default 'warning'
                 check (severity in ('warning', 'critical')),
  metric_value numeric not null,
  threshold    numeric not null,
  baseline     numeric,
  window_start timestamptz not null,
  window_end   timestamptz not null,
  detail       jsonb,
  runbook_url  text,
  status       text not null default 'open'
                 check (status in ('open', 'acknowledged', 'resolved')),
  notified_at  timestamptz,
  acknowledged_by uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- One alert per org + kind + window, so a re-scan of the same window never
  -- duplicates or re-notifies.
  unique (org_id, kind, window_start)
);

create index if not exists security_anomalies_org_status_idx
  on public.security_anomalies (org_id, status, created_at desc);

drop trigger if exists security_anomalies_set_updated_at on public.security_anomalies;
create trigger security_anomalies_set_updated_at before update on public.security_anomalies
  for each row execute function public.set_updated_at();

-- ── Row-Level Security ───────────────────────────────────────────────────────
alter table public.ai_usage_log       enable row level security;
alter table public.security_events    enable row level security;
alter table public.security_anomalies enable row level security;

-- ai_usage_log: any org member may INSERT their own call rows (the agent routes
-- run on the caller's RLS client); reads are leadership-only (cost is sensitive).
drop policy if exists ai_usage_log_insert on public.ai_usage_log;
create policy ai_usage_log_insert on public.ai_usage_log for insert
  with check (org_id = public.current_org_id());
drop policy if exists ai_usage_log_select on public.ai_usage_log;
create policy ai_usage_log_select on public.ai_usage_log for select
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo'));

-- security_events: any org member may INSERT a signal (the emitters run on the
-- caller's client, and unauthenticated failed-login rows are written server-side
-- with the service role, which bypasses RLS). Reads are leadership-only.
drop policy if exists security_events_insert on public.security_events;
create policy security_events_insert on public.security_events for insert
  with check (org_id = public.current_org_id());
drop policy if exists security_events_select on public.security_events;
create policy security_events_select on public.security_events for select
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo'));

-- security_anomalies: leadership READ (the alert board) + leadership UPDATE
-- (acknowledge / resolve). The monitor INSERTS with the service role, so no
-- client insert policy is needed — this closes the door on client-side inserts.
drop policy if exists security_anomalies_select on public.security_anomalies;
create policy security_anomalies_select on public.security_anomalies for select
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo'));
drop policy if exists security_anomalies_update on public.security_anomalies;
create policy security_anomalies_update on public.security_anomalies for update
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo'))
  with check (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo'));
