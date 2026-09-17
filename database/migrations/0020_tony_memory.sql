-- Mthryve OS — Migration 0020: Tony Memory (durable facts)
-- Tony's persistent, org-scoped memory: durable facts the grounded assistant
-- loads into context on every call so it can answer "what did we decide / what
-- are we working on" without re-deriving. The table was provisioned live ahead
-- of this migration; this file makes the repo authoritative and idempotent, and
-- adds the missing updated_at trigger so edits stamp updated_at.
--
-- RLS mirrors the rest of the OS: org-scoped read/insert/update for any member,
-- delete restricted to leadership (ceo/coo) and department heads — a durable
-- fact should not be quietly removed by any team member.
-- Applied to project otepdjhrawtqkzclaxbk.

create table if not exists tony_memory (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  category text not null default 'fact',
  content text not null,
  source text,
  pinned boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tony_memory_org_idx on tony_memory(org_id);
create index if not exists tony_memory_pinned_idx on tony_memory(org_id, pinned, updated_at desc);

alter table tony_memory enable row level security;

drop policy if exists tony_memory_org_select on tony_memory;
create policy tony_memory_org_select on tony_memory for select
  using (org_id = current_org_id());

drop policy if exists tony_memory_org_insert on tony_memory;
create policy tony_memory_org_insert on tony_memory for insert
  with check (org_id = current_org_id());

drop policy if exists tony_memory_org_update on tony_memory;
create policy tony_memory_org_update on tony_memory for update
  using (org_id = current_org_id());

drop policy if exists tony_memory_leadership_delete on tony_memory;
create policy tony_memory_leadership_delete on tony_memory for delete
  using (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo', 'department_head')
  );

drop trigger if exists tony_memory_set_updated_at on tony_memory;
create trigger tony_memory_set_updated_at before update on tony_memory
  for each row execute function set_updated_at();
