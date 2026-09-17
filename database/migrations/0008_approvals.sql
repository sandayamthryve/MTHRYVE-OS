-- Mthryve OS — Migration 0008: Approvals + Audit logs
-- The human-in-the-loop gate from DECISIONS.md D-005: proposals (from a human
-- or, later, the AI assistant) land here as pending, a manager approves/rejects,
-- and every decision is written to audit_logs.
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-07.

create type approval_status as enum ('pending', 'approved', 'rejected');

create table approval_requests (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  requested_by_agent boolean not null default false,
  action_type text not null,
  title text not null,
  payload jsonb not null default '{}',
  status approval_status not null default 'pending',
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index approval_requests_org_status_idx on approval_requests(org_id, status);

create table audit_logs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  action text not null,
  target_table text,
  target_id uuid,
  diff jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on audit_logs(org_id, created_at desc);

create trigger approval_requests_set_updated_at before update on approval_requests
  for each row execute function set_updated_at();

alter table approval_requests enable row level security;
alter table audit_logs enable row level security;

create policy approval_requests_select on approval_requests for select
  using (org_id = current_org_id());
create policy approval_requests_insert on approval_requests for insert
  with check (org_id = current_org_id());
create policy approval_requests_update on approval_requests for update
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo', 'department_head'));

create policy audit_logs_insert on audit_logs for insert
  with check (org_id = current_org_id());
create policy audit_logs_select on audit_logs for select
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));
