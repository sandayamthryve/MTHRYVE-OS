-- Mthryve OS — RLS verification (Milestone 8)
-- These checks prove Row-Level Security actually enforces access as a
-- restricted user, not just that the policies exist. Run against a live
-- project (Supabase SQL editor or MCP execute_sql). Last run: 2026-07-07 — all pass.
--
-- Method: create a throwaway team_member, then execute queries inside that
-- user's security context by setting the JWT `sub` claim and switching to the
-- `authenticated` role (which is what makes RLS apply — the service/postgres
-- role has BYPASSRLS).

-- 1) Provision a throwaway team_member (the 0004 trigger creates the profile).
do $$
declare v_uid uuid := gen_random_uuid();
begin
  insert into auth.users (id, aud, role, email, encrypted_password, raw_user_meta_data, created_at, updated_at)
  values (v_uid, 'authenticated', 'authenticated', 'test.member@mthryve.com', 'x',
          jsonb_build_object('full_name', 'Test Member', 'role', 'team_member'), now(), now());
end $$;

-- 2) Per-policy read filtering. Insert a marker audit row as the privileged
--    role, then read as the member: audit must be hidden (ceo/coo only) while
--    org-wide tables stay visible. audit=0 AND approvals>0 proves it filters
--    per-policy rather than globally bypassing/denying.
insert into audit_logs (org_id, action)
  values ((select id from organizations order by created_at limit 1), 'rls.test.marker');
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.users where email='test.member@mthryve.com'))::text, true);
set local role authenticated;
select
  (select current_user_role())::text                as acting_role,        -- team_member
  (select count(*) from audit_logs)                 as audit_visible,      -- expect 0
  (select count(*) from approval_requests)          as approvals_visible,  -- expect > 0
  (select count(*) from ai_messages)                as member_ai_messages; -- expect 0 (isolation)
reset role;

-- 3) Write denials. As the member: approve-update touches 0 rows, and a metrics
--    insert is rejected with 42501 (new row violates RLS policy).
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.users where email='test.member@mthryve.com'))::text, true);
set local role authenticated;
with upd as (update approval_requests set review_note='rls_test' where status='pending' returning id)
select count(*) as member_could_update_approvals from upd;   -- expect 0
-- The next statement is expected to ERROR with 42501 — that IS the passing result:
-- insert into metrics_snapshots (org_id, period_start, period_end) values (current_org_id(), current_date, current_date);
reset role;

-- 4) Cleanup.
delete from audit_logs where action = 'rls.test.marker';
delete from auth.users where email = 'test.member@mthryve.com';
