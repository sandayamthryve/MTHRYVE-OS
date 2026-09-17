-- Migration 0013: revoke the audit trigger function's RPC grant from
-- `authenticated` (mirrors the 0003/0006 pattern for trigger functions).
-- The function is only ever invoked by the triggers created in 0011; no role
-- should be able to call it directly via PostgREST.
revoke execute on function public.audit_privileged_change() from authenticated;
