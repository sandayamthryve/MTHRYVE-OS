-- Migration 0014: decide_approval() — atomic, RLS-enforced approval decision.
-- SECURITY INVOKER: runs as the calling reviewer, so RLS + the actor
-- (auth.uid()) are un-forgeable. Executes the proposed action (create_task),
-- records the decision, and lets the 0011 audit trigger fire — all in one
-- transaction. The approvals UI calls only this RPC (requestId/decision/note).
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

revoke execute on function public.decide_approval(uuid, text, text) from public, anon;
grant execute on function public.decide_approval(uuid, text, text) to authenticated;
