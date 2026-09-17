-- Migration 0011: Tamper-proof audit logging (INC-2026-002)
create or replace function public.audit_privileged_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'approval_requests' then
    if old.status is distinct from new.status
       and new.status in ('approved', 'rejected') then
      insert into public.audit_logs (org_id, actor_id, action, target_table, target_id, diff)
      values (
        new.org_id,
        auth.uid(),
        'approval.' || new.status::text,
        'approval_requests',
        new.id,
        jsonb_build_object(
          'from', old.status::text,
          'to', new.status::text,
          'action_type', new.action_type,
          'review_note', new.review_note
        )
      );
    end if;
  elsif tg_table_name = 'users' then
    if old.role is distinct from new.role then
      insert into public.audit_logs (org_id, actor_id, action, target_table, target_id, diff)
      values (
        new.org_id,
        auth.uid(),
        'user.role_changed',
        'users',
        new.id,
        jsonb_build_object('from', old.role::text, 'to', new.role::text)
      );
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.audit_privileged_change() from public, anon;

create trigger approval_requests_audit
  after update on public.approval_requests
  for each row execute function public.audit_privileged_change();

create trigger users_audit
  after update on public.users
  for each row execute function public.audit_privileged_change();

drop policy if exists audit_logs_insert on public.audit_logs;
