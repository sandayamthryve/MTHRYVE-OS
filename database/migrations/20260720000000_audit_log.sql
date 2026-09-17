-- Mthryve OS — Migration 20260720000000: audit_log (privileged-action trail)
--
-- The tamper-evident record of PRIVILEGED actions across the OS — role and
-- employment changes, the governed permanent-delete lifecycle, probation
-- decisions, and approval decisions. Distinct from action_audit (the
-- action-request spine) and security_events (the anomaly signal feed): this is
-- the single "who did what to whom, and when" ledger leadership reviews at
-- /security/audit.
--
-- GOVERNING RULES (mirror the rest of the OS):
--   1. Standard stack + RLS. Reuses current_org_id() / current_user_role().
--   2. WRITE is SERVICE-ROLE ONLY — there is no INSERT policy, so the anon/auth
--      clients can never write (or forge) an audit row. lib/audit/log.ts always
--      writes with the service-role key, which bypasses RLS. This guarantees the
--      trail can't be blocked by RLS and can't be tampered with from a session.
--   3. READ is LEADERSHIP-only (ceo/coo) and org-scoped — the same authority
--      that reads security_events / ai_usage_log.
--   4. Idempotent (create-if-not-exists) — the table is already live; this file
--      makes the contract reproducible for fresh databases and CI.
--
-- Applied to project otepdjhrawtqkzclaxbk (migration `audit_log`).

-- ── audit_log: one row per privileged action ─────────────────────────────────
create table if not exists public.audit_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null
                   references public.organizations(id) on delete cascade,
  -- The acting user + their role, captured from the verified session at write
  -- time. Null actor_user_id = a system-executed step (e.g. the governed delete
  -- executor), which stamps actor_role='system'.
  actor_user_id  uuid references public.users(id) on delete set null,
  actor_role     text,
  -- Caps-snake verb, e.g. 'role_change', 'delete_executed', 'approval_decision'.
  action         text not null,
  -- What the action touched. entity_type names the kind ('user', 'action_request',
  -- 'task', ...); entity_id is that row's id (text so a non-uuid key is still
  -- recordable — the trail must never reject a write).
  entity_type    text,
  entity_id      text,
  -- Small before→after / decision payload. Never the full row, never secrets.
  detail         jsonb,
  ip             text,
  created_at     timestamptz not null default now()
);

create index if not exists audit_log_org_time_idx
  on public.audit_log (org_id, created_at desc);
create index if not exists audit_log_org_action_time_idx
  on public.audit_log (org_id, action, created_at desc);
create index if not exists audit_log_org_entity_idx
  on public.audit_log (org_id, entity_type, entity_id);

-- ── Row-Level Security ───────────────────────────────────────────────────────
alter table public.audit_log enable row level security;

-- READ: leadership only, own org. No INSERT/UPDATE/DELETE policy exists by
-- design — every write goes through the service role (which bypasses RLS), so
-- the trail is append-only-from-the-app and unforgeable from a user session.
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select
  using (org_id = public.current_org_id() and public.current_user_role() in ('ceo', 'coo'));
