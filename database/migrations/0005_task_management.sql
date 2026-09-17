-- Mthryve OS — Migration 0005: Task Management
-- projects → tasks → subtasks (self-ref), comments, attachments.
-- Every table carries created_at / updated_at / created_by / status per the
-- master brief. org_id is denormalized onto projects and tasks as a scoping
-- key (not business data) so RLS stays simple and fast.
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-07.

create type project_status as enum ('active', 'on_hold', 'completed', 'archived');
create type task_status as enum ('todo', 'in_progress', 'blocked', 'done', 'cancelled');
create type task_priority as enum ('low', 'medium', 'high', 'urgent');

create table projects (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  department_id uuid references departments(id) on delete set null,
  brand_id uuid references brands(id) on delete set null,
  name text not null,
  description text,
  owner_id uuid references users(id) on delete set null,
  due_date date,
  status project_status not null default 'active',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_org_idx on projects(org_id);

create table tasks (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  parent_task_id uuid references tasks(id) on delete cascade,
  brand_id uuid references brands(id) on delete set null,
  title text not null,
  description text,
  assignee_id uuid references users(id) on delete set null,
  priority task_priority not null default 'medium',
  due_date date,
  status task_status not null default 'todo',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_org_idx on tasks(org_id);
create index tasks_project_idx on tasks(project_id);
create index tasks_parent_idx on tasks(parent_task_id);
create index tasks_assignee_idx on tasks(assignee_id);

create table task_comments (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null references tasks(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index task_comments_task_idx on task_comments(task_id);

create table task_attachments (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null references tasks(id) on delete cascade,
  file_url text not null,
  file_type text,
  file_name text,
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index task_attachments_task_idx on task_attachments(task_id);

create trigger projects_set_updated_at before update on projects
  for each row execute function set_updated_at();
create trigger tasks_set_updated_at before update on tasks
  for each row execute function set_updated_at();
create trigger task_comments_set_updated_at before update on task_comments
  for each row execute function set_updated_at();

alter table projects enable row level security;
alter table tasks enable row level security;
alter table task_comments enable row level security;
alter table task_attachments enable row level security;

create policy projects_select on projects for select using (org_id = current_org_id());
create policy projects_insert on projects for insert with check (org_id = current_org_id());
create policy projects_update on projects for update using (org_id = current_org_id());
create policy projects_delete on projects for delete using (org_id = current_org_id());

create policy tasks_select on tasks for select using (org_id = current_org_id());
create policy tasks_insert on tasks for insert with check (org_id = current_org_id());
create policy tasks_update on tasks for update using (org_id = current_org_id());
create policy tasks_delete on tasks for delete using (org_id = current_org_id());

create policy task_comments_select on task_comments for select
  using (task_id in (select id from tasks where org_id = current_org_id()));
create policy task_comments_insert on task_comments for insert
  with check (author_id = auth.uid() and task_id in (select id from tasks where org_id = current_org_id()));
create policy task_comments_delete on task_comments for delete
  using (author_id = auth.uid());

create policy task_attachments_select on task_attachments for select
  using (task_id in (select id from tasks where org_id = current_org_id()));
create policy task_attachments_insert on task_attachments for insert
  with check (task_id in (select id from tasks where org_id = current_org_id()));
create policy task_attachments_delete on task_attachments for delete
  using (uploaded_by = auth.uid());
