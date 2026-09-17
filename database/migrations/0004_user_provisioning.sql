-- Mthryve OS — Migration 0004: Auto-provision public.users on signup + INSERT policy
-- Without this, a newly-authenticated auth.users row has no matching
-- public.users profile, so current_org_id()/current_user_role() return NULL and
-- every RLS-scoped query returns empty. This trigger creates the profile row,
-- pulling org/name/role from invite metadata with single-tenant-safe defaults.
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-06 (trigger verified live).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_role public.user_role;
begin
  -- Single-tenant MVP: attach every new user to the one Mthryve org.
  -- When multi-tenant activates, org_id will come from the invite metadata instead.
  select id into v_org_id from public.organizations order by created_at limit 1;

  -- Role comes from invite metadata; default to least-privilege team_member.
  begin
    v_role := coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'team_member');
  exception when others then
    v_role := 'team_member';
  end;

  insert into public.users (id, org_id, full_name, email, role, department_id)
  values (
    new.id,
    v_org_id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    new.email,
    v_role,
    nullif(new.raw_user_meta_data ->> 'department_id', '')::uuid
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Allow a signed-in user to insert only their OWN profile row (belt-and-suspenders
-- alongside the trigger; the trigger runs as definer, this covers app-side inserts).
create policy "users_insert_self"
  on public.users for insert
  with check (id = auth.uid());
