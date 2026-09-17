-- Migration 0016: tiered AI model access + governance (DECISIONS.md D-012)
-- Three Anthropic tiers (lite=Haiku, standard=Sonnet, premium=Opus). Default
-- tier is by role; a higher tier for a specific task is requested through the
-- approval queue (action_type = 'model_access') and, on approval, produces a
-- single-use grant. Per-task approval — maximum control + audit.

create type model_tier as enum ('lite', 'standard', 'premium');

create table public.model_grants (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  tier        model_tier not null,
  reason      text,
  request_id  uuid references public.approval_requests (id) on delete set null,
  granted_by  uuid references public.users (id),
  used_at     timestamptz,            -- null = unused (single-use per approved task)
  expires_at  timestamptz,            -- optional safety expiry
  created_at  timestamptz not null default now()
);
create index model_grants_unused_idx on public.model_grants (user_id) where used_at is null;

alter table public.model_grants enable row level security;

-- Read: your own grants; ceo/coo see all in the org.
create policy model_grants_select on public.model_grants
  for select using (
    org_id = public.current_org_id()
    and (user_id = auth.uid() or public.current_user_role() in ('ceo', 'coo'))
  );

-- Insert: only ceo/coo (this includes the decide_approval path, which runs as
-- the approving reviewer). Non-managers can never grant themselves a tier.
create policy model_grants_insert on public.model_grants
  for insert with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo')
  );

-- Update: the grantee marks their own grant used (the assistant route runs as
-- the consuming user).
create policy model_grants_update on public.model_grants
  for update using (
    org_id = public.current_org_id() and user_id = auth.uid()
  ) with check (
    org_id = public.current_org_id() and user_id = auth.uid()
  );

-- Cost visibility: record which model answered each message.
alter table public.ai_messages add column model text;

-- Extend decide_approval to also execute a 'model_access' approval: on approve,
-- mint a single-use grant for the requester. (SECURITY INVOKER, unchanged
-- otherwise — the reviewer-role check + atomicity from 0014 still apply.)
create or replace function public.decide_approval(
  p_request_id uuid,
  p_decision text,
  p_note text default null
)
returns public.approval_requests
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_req    public.approval_requests;
  v_actor  uuid := auth.uid();
  v_title  text;
  v_prio   public.task_priority;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decide_approval: decision must be approved or rejected'
      using errcode = '22023';
  end if;

  if public.current_user_role() not in ('ceo', 'coo', 'department_head') then
    raise exception 'decide_approval: a reviewer role is required'
      using errcode = '42501';
  end if;

  select * into v_req
  from public.approval_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'decide_approval: request not found or not visible'
      using errcode = 'P0002';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'decide_approval: request is already %', v_req.status
      using errcode = '22023';
  end if;

  -- Granting AI model access is a CEO/COO authority only (D-012) — tighter than
  -- the general reviewer set (which includes department heads).
  if v_req.action_type = 'model_access'
     and public.current_user_role() not in ('ceo', 'coo') then
    raise exception 'decide_approval: only CEO/COO can decide model-access requests'
      using errcode = '42501';
  end if;

  -- Execute the proposed action on approval.
  if p_decision = 'approved' and v_req.action_type = 'create_task' then
    v_title := nullif(btrim(coalesce(v_req.payload ->> 'title', '')), '');
    if v_title is not null then
      v_prio := coalesce(
        case when v_req.payload ->> 'priority' in ('low', 'medium', 'high', 'urgent')
             then (v_req.payload ->> 'priority')::public.task_priority end,
        'medium'
      );
      insert into public.tasks (org_id, title, priority, status, created_by)
      values (v_req.org_id, v_title, v_prio, 'todo', v_actor);
    end if;
  elsif p_decision = 'approved' and v_req.action_type = 'model_access'
        and v_req.requested_by is not null then
    -- Single-use grant of the requested tier (default premium) for the task.
    insert into public.model_grants (org_id, user_id, tier, reason, request_id, granted_by)
    values (
      v_req.org_id,
      v_req.requested_by,
      coalesce(
        case when v_req.payload ->> 'tier' in ('lite', 'standard', 'premium')
             then (v_req.payload ->> 'tier')::public.model_tier end,
        'premium'
      ),
      nullif(btrim(coalesce(v_req.payload ->> 'reason', '')), ''),
      v_req.id,
      v_actor
    );
  end if;

  update public.approval_requests
  set status      = p_decision::public.approval_status,
      reviewed_by = v_actor,
      reviewed_at = now(),
      review_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_request_id
  returning * into v_req;

  if not found then
    raise exception 'decide_approval: not authorized to decide this request'
      using errcode = '42501';
  end if;

  return v_req;
end;
$$;
