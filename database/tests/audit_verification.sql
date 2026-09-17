-- Mthryve OS — Audit-integrity verification (INC-2026-002 / Sprint 0)
-- Proves the audit trail is tamper-proof against a signed-in user, not just
-- that the trigger exists. Run against a live project (Supabase SQL editor or
-- MCP execute_sql). Last run: 2026-07-07 — all pass.
--
-- Threat model: a signed-in `authenticated` user (via PostgREST) must not be
-- able to forge, alter, or delete audit rows, or call the audit function
-- directly — while a legitimate privileged change still produces an
-- un-forgeable audit row whose actor is auth.uid().

-- 1) Structural guarantees ---------------------------------------------------
-- 1a) The audit function is SECURITY DEFINER and search_path-pinned.
select
  p.prosecdef                                   as is_security_definer,  -- expect true
  p.proconfig                                   as config                -- expect {search_path=""}
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'audit_privileged_change';

-- 1b) Both triggers are attached and enabled.
select c.relname as on_table, t.tgname as trigger, t.tgenabled as enabled  -- expect 'O'
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal and p.proname = 'audit_privileged_change'
order by c.relname;

-- 1c) audit_logs has NO write policy (only SELECT for ceo/coo). With RLS on
--     and no INSERT/UPDATE/DELETE policy, every client write is default-denied.
select polname,
  case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
              when 'w' then 'UPDATE' when 'd' then 'DELETE' else polcmd::text end as cmd
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'audit_logs';   -- expect exactly one row: SELECT

-- 1d) The audit function is not callable as an RPC by API roles (0011 + 0013).
select
  has_function_privilege('anon',          'public.audit_privileged_change()', 'execute') as anon_can_exec,          -- expect false
  has_function_privilege('authenticated', 'public.audit_privileged_change()', 'execute') as authenticated_can_exec; -- expect false

-- 2) Tamper resistance as a restricted user ----------------------------------
-- Provision a throwaway team_member (0004 trigger creates the profile).
do $$
declare v_uid uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
  values (v_uid, 'authenticated', 'authenticated', 'audit.test.member@mthryve.com', 'x',
          jsonb_build_object('full_name', 'Audit Test Member', 'role', 'team_member'), now(), now());
end $$;

-- As the member: a forged audit insert is rejected (new row violates RLS), and
-- update/delete of existing audit rows touch 0 rows.
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.users where email='audit.test.member@mthryve.com'))::text, true);
set local role authenticated;
do $$
begin
  begin
    insert into audit_logs (org_id, actor_id, action)
      values (current_org_id(), auth.uid(), 'forged.by.member');
    raise exception 'FAIL: member was able to insert an audit row';
  exception when insufficient_privilege or check_violation then
    raise notice 'PASS: forged audit insert denied (%.)', sqlstate;
  end;
end $$;
with d as (delete from audit_logs returning 1)
select count(*) as member_could_delete_audit from d;   -- expect 0
reset role;

-- 3) Legitimate privileged change still audits (un-forgeable actor) ----------
-- Done inside a transaction that is rolled back, so no real data changes.
-- Fire the trigger by flipping a pending approval to approved as a reviewer,
-- then confirm exactly one fresh audit row exists with actor = the reviewer.
begin;
  select set_config('request.jwt.claims',
    json_build_object('sub', (select id from public.users
                              where role in ('ceo','coo') order by created_at limit 1))::text, true);
  set local role authenticated;
  -- Use decide_approval so the check matches the real UI path; skip cleanly if
  -- there is no pending request to act on.
  do $$
  declare v_id uuid;
  begin
    select id into v_id from approval_requests where status = 'pending' order by created_at limit 1;
    if v_id is null then
      raise notice 'SKIP: no pending approval to exercise the trigger';
    else
      perform decide_approval(v_id, 'approved', 'audit_verification');
      if exists (
        select 1 from audit_logs
        where target_id = v_id and actor_id = auth.uid() and action = 'approval.approved'
      ) then
        raise notice 'PASS: privileged change wrote an audit row with actor = auth.uid()';
      else
        raise exception 'FAIL: no audit row produced for the approval';
      end if;
    end if;
  end $$;
  reset role;
rollback;

-- 4) Cleanup.
delete from auth.users where email = 'audit.test.member@mthryve.com';
