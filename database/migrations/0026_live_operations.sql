-- Mthryve OS — Migration 0026: Live Operations module (additive)
--
-- The dedicated Live Operations surface REUSES the existing rich live_sessions
-- table as the single source of truth for every live metric (gmv, orders,
-- impressions, clicks, ctr, ctor, peak_viewers, avg_viewers, units_sold,
-- duration_minutes, source, demographics …). Dashboards AGGREGATE those rows —
-- they are never re-encoded into metric_entries or any parallel store. This
-- migration only ADDS the report fields the Daily Live Report needs plus two
-- supporting tables (attachments, bottlenecks).
--
-- GOVERNING RULES (mirror the rest of the platform):
--   1. One home per fact. Live metrics live in live_sessions only. Every new
--      column here is nullable — an unrecorded value is NULL (honest "—"),
--      never a fabricated 0.
--   2. Hybrid origin. live_sessions.source already tags 'api' vs 'manual'. The
--      encode form is the primary path (TikTok exposes almost nothing at
--      live-session granularity); a sync writes 'api' on a separate path and
--      manual saves never silently overwrite an 'api' value (enforced in the app
--      + surfaced as a divergence flag).
--   3. Money never auto-moves. AI recommendations route to PENDING
--      action_requests (reusing the existing spine) — nothing auto-executes.
--   4. Reuse: anchors, op_records (view-only), attendance (HR),
--      account_review_briefs (AI brief), tasks. RLS on everything; approval
--      fields are leadership-only via a guard trigger mirroring
--      trg_guard_metric_entry_approval.
--
-- Reuses current_org_id() / current_user_role() / current_user_team() /
-- set_updated_at(). Idempotent where practical. Applied to project
-- otepdjhrawtqkzclaxbk with this commit.

-- ── PART A.1 — Additive columns on live_sessions (all nullable) ───────────────
-- Session Information (header) fields, the standard-metrics fields the report
-- adds beyond what live_sessions already stored, and the qualitative assessment.
-- Total Live Hours is COMPUTED from started_at/ended_at (or duration_minutes);
-- duration_minutes stays the store, so no hours column is added.
alter table public.live_sessions
  add column if not exists session_number            text,
  add column if not exists moderator_id              uuid references public.users(id) on delete set null,
  add column if not exists team_leader_id             uuid references public.users(id) on delete set null,
  add column if not exists studio                     text,
  add column if not exists shift                      text,
  add column if not exists viewers                    integer,
  add column if not exists likes                      integer,
  add column if not exists shares                     integer,
  add column if not exists comments                   integer,
  add column if not exists new_followers              integer,
  add column if not exists returning_viewers          integer,
  add column if not exists product_clicks             integer,
  add column if not exists viewer_retention           numeric,
  add column if not exists engagement_rate            numeric,
  add column if not exists total_sales                numeric,
  add column if not exists aov                        numeric,
  add column if not exists conversion_rate            numeric,
  add column if not exists featured_products          text,
  add column if not exists expected_duration_minutes  integer,
  -- assessment = { highlights, challenges, customer_insights, competitor_obs }
  add column if not exists assessment                 jsonb not null default '{}'::jsonb,
  -- Daily Live Report lifecycle, kept off the operational `status`
  -- (scheduled/live/ended) so a report can be drafted → submitted → reviewed
  -- without disturbing the session's run state.
  add column if not exists report_status              text not null default 'draft'
    check (report_status in ('draft','submitted','reviewed')),
  add column if not exists report_submitted_at        timestamptz,
  add column if not exists report_submitted_by        uuid references public.users(id) on delete set null,
  add column if not exists report_reviewed_at         timestamptz,
  add column if not exists report_reviewed_by         uuid references public.users(id) on delete set null;

comment on column public.live_sessions.assessment is
  'Qualitative Session Assessment jsonb: { highlights, challenges, customer_insights, competitor_obs }.';
comment on column public.live_sessions.report_status is
  'Daily Live Report lifecycle: draft → submitted → reviewed. Distinct from operational status.';

-- ── PART A.2 — live_session_attachments ───────────────────────────────────────
-- Files supporting a Session Assessment (screenshots, exports). The raw bytes
-- live in a private Storage bucket ('live-ops'), org-folder scoped; this row is
-- the metadata + object path.
create table if not exists public.live_session_attachments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null default public.current_org_id()
                 references public.organizations(id) on delete cascade,
  session_id   uuid not null references public.live_sessions(id) on delete cascade,
  url          text not null,                 -- Storage object path ('<org>/<session>/<file>') or external URL
  kind         text,                          -- 'image' | 'export' | 'doc' | 'link' | …
  uploaded_by  uuid default auth.uid() references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists live_session_attachments_session_idx
  on public.live_session_attachments(session_id);
create index if not exists live_session_attachments_org_idx
  on public.live_session_attachments(org_id, created_at desc);

-- ── PART A.3 — live_bottlenecks ───────────────────────────────────────────────
-- One reported problem from a live session, categorized so the Bottleneck
-- dashboard can consolidate by category / brand / severity, then assign it
-- (assignment creates a task — see the app).
create table if not exists public.live_bottlenecks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id()
                  references public.organizations(id) on delete cascade,
  session_id    uuid not null references public.live_sessions(id) on delete cascade,
  brand_id      uuid references public.brands(id) on delete set null,
  category      text not null check (category in (
                  'inventory_shortage','product_availability','voucher','pricing',
                  'technical','connectivity','av','platform_error','customer_complaint',
                  'anchor_performance','moderator_performance','delivery')),
  note          text,
  severity      text not null default 'medium' check (severity in ('low','medium','high','critical')),
  status        text not null default 'open' check (status in ('open','assigned','in_progress','resolved','dismissed')),
  assigned_dept text,
  assigned_to   uuid references public.users(id) on delete set null,
  task_id       uuid references public.tasks(id) on delete set null,   -- the task created on assignment
  created_by    uuid default auth.uid() references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists live_bottlenecks_org_cat_idx
  on public.live_bottlenecks(org_id, category, status);
create index if not exists live_bottlenecks_brand_idx on public.live_bottlenecks(brand_id);
create index if not exists live_bottlenecks_session_idx on public.live_bottlenecks(session_id);

drop trigger if exists live_bottlenecks_set_updated_at on public.live_bottlenecks;
create trigger live_bottlenecks_set_updated_at before update on public.live_bottlenecks
  for each row execute function public.set_updated_at();

-- ── PART A.4 — Approval guard on the live report review fields ────────────────
-- The report_status/report_reviewed_* columns are org-open for RLS UPDATE (so
-- the Live Ops team can draft → submit a report), but marking a report
-- 'reviewed' — or stamping report_reviewed_by/at — is leadership-only, enforced
-- here at the row level so no client path can review without a leader. Mirrors
-- trg_guard_metric_entry_approval / op_records_approval_guard.
create or replace function public.guard_live_session_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- coalesce so a NULL/unknown role is treated as non-leadership and blocked
  -- (mirrors guard_metric_entry_approval; `null not in (...)` would be NULL, not
  -- TRUE, and would fail to fire).
  if (new.report_status is distinct from old.report_status and new.report_status = 'reviewed')
     or (new.report_reviewed_by is distinct from old.report_reviewed_by)
     or (new.report_reviewed_at is distinct from old.report_reviewed_at) then
    if coalesce(public.current_user_role()::text, '') not in ('ceo','coo','department_head') then
      raise exception 'live_sessions: only ceo/coo/department_head may mark a live report reviewed'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_live_session_review() from public, anon, authenticated;

drop trigger if exists trg_guard_live_session_review on public.live_sessions;
create trigger trg_guard_live_session_review before update on public.live_sessions
  for each row execute function public.guard_live_session_review();

-- ── PART A.5 — RLS ────────────────────────────────────────────────────────────
-- live_sessions already has org read + org write policies (live_sessions_org_*).
-- The two new tables get org read; write for the Live Operations team +
-- leadership. current_user_team() is free text, so we match case-insensitively
-- on 'live' (e.g. 'Live Operations', 'Live Ops') OR any leadership role.
alter table public.live_session_attachments enable row level security;
alter table public.live_bottlenecks enable row level security;

-- Helper predicate inlined per policy (no new function needed): leadership, or a
-- member whose team_assignment mentions "live".
--   current_user_role() in ('ceo','coo','department_head')
--   or lower(coalesce(current_user_team(),'')) like '%live%'

-- live_session_attachments
drop policy if exists live_session_attachments_select on public.live_session_attachments;
create policy live_session_attachments_select on public.live_session_attachments for select
  using (org_id = public.current_org_id());

drop policy if exists live_session_attachments_write on public.live_session_attachments;
create policy live_session_attachments_write on public.live_session_attachments for all
  using (
    org_id = public.current_org_id()
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  )
  with check (
    org_id = public.current_org_id()
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  );

-- live_bottlenecks
drop policy if exists live_bottlenecks_select on public.live_bottlenecks;
create policy live_bottlenecks_select on public.live_bottlenecks for select
  using (org_id = public.current_org_id());

drop policy if exists live_bottlenecks_write on public.live_bottlenecks;
create policy live_bottlenecks_write on public.live_bottlenecks for all
  using (
    org_id = public.current_org_id()
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  )
  with check (
    org_id = public.current_org_id()
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  );

-- ── PART A.6 — Private Storage bucket for assessment attachments ──────────────
-- Object path convention: '<org_id>/<session_id>/<filename>' — the first path
-- segment is the org, so org scoping is a folder check. Private bucket; files
-- are never served anonymously. Read = org members; write = Live Ops team +
-- leadership, within their own org folder.
insert into storage.buckets (id, name, public)
values ('live-ops', 'live-ops', false)
on conflict (id) do nothing;

drop policy if exists "live_ops_bucket_read" on storage.objects;
create policy "live_ops_bucket_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'live-ops'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

drop policy if exists "live_ops_bucket_insert" on storage.objects;
create policy "live_ops_bucket_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'live-ops'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  );

drop policy if exists "live_ops_bucket_update" on storage.objects;
create policy "live_ops_bucket_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'live-ops'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  )
  with check (
    bucket_id = 'live-ops'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  );

drop policy if exists "live_ops_bucket_delete" on storage.objects;
create policy "live_ops_bucket_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'live-ops'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (public.current_user_role() in ('ceo','coo','department_head')
         or lower(coalesce(public.current_user_team(),'')) like '%live%')
  );
