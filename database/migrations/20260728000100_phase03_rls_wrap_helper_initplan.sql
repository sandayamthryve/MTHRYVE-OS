-- Phase 0.3 (B) — wrap current_org_id() / current_user_role() / current_user_team()
-- in (select ...) across EVERY public policy that calls them, so each auth/helper
-- call evaluates ONCE per query (InitPlan) instead of once per row.
--
-- These helpers are STABLE SECURITY DEFINER, so (select fn()) returns the SAME
-- value as fn() — access is IDENTICAL; this is purely a performance transform (the
-- documented Supabase RLS `auth_rls_initplan` optimization applied to the OS's own
-- org/role/team helpers).
--
-- Idempotent: each expression is first UNWRAPPED (any existing "(select fn())" is
-- reduced to a bare "fn()") and then RE-WRAPPED to the one canonical form, so
-- re-running this migration is a no-op. auth.uid() (already wrapped upstream) is
-- deliberately left untouched.

DO $$
DECLARE r record; nu text; nc text; stmt text;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, p.polname AS pol,
           pg_get_expr(p.polqual, p.polrelid)      AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS chk
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND ( pg_get_expr(p.polqual, p.polrelid)      ~* '(current_org_id|current_user_role|current_user_team)\(\)'
         OR pg_get_expr(p.polwithcheck, p.polrelid) ~* '(current_org_id|current_user_role|current_user_team)\(\)' )
  LOOP
    nu := r.qual; nc := r.chk;
    IF nu IS NOT NULL THEN
      nu := regexp_replace(nu, '\(\s*select\s+(current_org_id|current_user_role|current_user_team)\(\)(\s+as\s+[a-z_]+)?\s*\)', '\1()', 'gi');
      nu := regexp_replace(nu, '(current_org_id|current_user_role|current_user_team)\(\)', '(select \1())', 'g');
    END IF;
    IF nc IS NOT NULL THEN
      nc := regexp_replace(nc, '\(\s*select\s+(current_org_id|current_user_role|current_user_team)\(\)(\s+as\s+[a-z_]+)?\s*\)', '\1()', 'gi');
      nc := regexp_replace(nc, '(current_org_id|current_user_role|current_user_team)\(\)', '(select \1())', 'g');
    END IF;
    stmt := format('ALTER POLICY %I ON public.%I', r.pol, r.tbl);
    IF nu IS NOT NULL THEN stmt := stmt || format(' USING (%s)', nu); END IF;
    IF nc IS NOT NULL THEN stmt := stmt || format(' WITH CHECK (%s)', nc); END IF;
    EXECUTE stmt;
  END LOOP;
END $$;
