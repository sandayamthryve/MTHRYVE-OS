-- Mthryve OS — Migration 0023: Growth Pods (pods + pod_brands)
--
-- The Growth Pod model behind Vesper (the Operator agent) and the Growth
-- Scoreboard. A pod is a small operating team with a lead and a target number of
-- brands; pod_brands assigns brands (clients) to a pod. The Scoreboard reads
-- live GMV/ROAS per pod off these assignments.
--
-- These two tables were provisioned out-of-band on project otepdjhrawtqkzclaxbk
-- (like content_performance and the action_requests spine — see 0022). This
-- migration records that schema in version control so it is reproducible. It is
-- ADDITIVE and idempotent (create-if-not-exists + drop/create policies), so it
-- is safe to re-run and safe against the already-provisioned tables.
--
-- RLS (leadership-gated writes): every authenticated org member may SELECT pods
-- and their brand assignments (the Scoreboard is a shared cockpit); only
-- leadership — ceo / coo / department_head — may create pods, set the lead /
-- target, and assign or unassign brands. current_org_id() / current_user_role()
-- are the same SECURITY DEFINER helpers the rest of the OS uses.

create table if not exists public.pods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  name text not null,
  lead_user_id uuid references public.users(id) on delete set null,
  target_brands integer,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pods_org_idx on public.pods(org_id);

create table if not exists public.pod_brands (
  org_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  pod_id uuid not null references public.pods(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (pod_id, brand_id)
);
create index if not exists pod_brands_org_idx on public.pod_brands(org_id);
create index if not exists pod_brands_brand_idx on public.pod_brands(brand_id);

alter table public.pods enable row level security;
alter table public.pod_brands enable row level security;

-- Read is open to the whole org; write is leadership-gated. Drop-then-create so
-- the policy set is exactly this whether or not the out-of-band provisioning
-- already installed one.
drop policy if exists pods_select on public.pods;
create policy pods_select on public.pods for select
  using (org_id = current_org_id());

drop policy if exists pods_write on public.pods;
create policy pods_write on public.pods for all
  using (org_id = current_org_id()
         and current_user_role() = any (array['ceo','coo','department_head']::user_role[]))
  with check (org_id = current_org_id()
         and current_user_role() = any (array['ceo','coo','department_head']::user_role[]));

drop policy if exists pod_brands_select on public.pod_brands;
create policy pod_brands_select on public.pod_brands for select
  using (org_id = current_org_id());

drop policy if exists pod_brands_write on public.pod_brands;
create policy pod_brands_write on public.pod_brands for all
  using (org_id = current_org_id()
         and current_user_role() = any (array['ceo','coo','department_head']::user_role[]))
  with check (org_id = current_org_id()
         and current_user_role() = any (array['ceo','coo','department_head']::user_role[]));
