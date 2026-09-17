-- Mthryve OS — Migration 0009: Metrics + Reports
-- The universal metric set (DECISIONS.md D-004): GMV Impact, Efficiency,
-- Quality Score, Capacity Utilization — one row per department (and optionally
-- brand) per period. Reports are generated rollups over those snapshots.
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-07.

create type report_type as enum ('daily', 'weekly', 'monthly');

create table metrics_snapshots (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  department_id uuid references departments(id) on delete cascade,
  brand_id uuid references brands(id) on delete set null,
  gmv_impact numeric(12, 2) not null default 0,
  efficiency numeric(5, 2) not null default 0,
  quality_score numeric(5, 2) not null default 0,
  capacity_utilization numeric(5, 2) not null default 0,
  period_start date not null,
  period_end date not null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index metrics_snapshots_org_period_idx on metrics_snapshots(org_id, period_end desc);
create index metrics_snapshots_dept_idx on metrics_snapshots(department_id);

create table reports (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  type report_type not null default 'weekly',
  title text not null,
  period_start date not null,
  period_end date not null,
  generated_by uuid references users(id) on delete set null,
  content jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index reports_org_idx on reports(org_id, created_at desc);

create trigger metrics_snapshots_set_updated_at before update on metrics_snapshots
  for each row execute function set_updated_at();

alter table metrics_snapshots enable row level security;
alter table reports enable row level security;

create policy metrics_snapshots_select on metrics_snapshots for select
  using (org_id = current_org_id());
create policy metrics_snapshots_insert on metrics_snapshots for insert
  with check (org_id = current_org_id() and current_user_role() in ('ceo', 'coo', 'department_head'));
create policy metrics_snapshots_update on metrics_snapshots for update
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo', 'department_head'));

create policy reports_select on reports for select using (org_id = current_org_id());
create policy reports_insert on reports for insert with check (org_id = current_org_id());
