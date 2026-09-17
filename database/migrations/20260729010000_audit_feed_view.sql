-- Mthryve OS — Migration 20260729010000: audit_feed (the unified read-back view)
--
-- The Review Gate spine (action_audit) and the privileged-action ledger
-- (audit_log) each record decisions faithfully — but nothing read them back as
-- ONE chronological story. This view is that read-back surface, and NOTHING
-- more: it invents no new storage, writes nothing, and duplicates no row. It is
-- a pure UNION ALL of the two existing trails, so the system can finally explain
-- itself at /audit.
--
-- GOVERNING RULES:
--   1. READ-ONLY. A view over the two live tables. No table, no second feed, no
--      copied data — every figure resolves live from the underlying rows.
--   2. TRAILS STAY LABELLED. Each row carries `trail` ('action_audit' or
--      'audit_log') so the two are never blended into one indistinguishable
--      stream — the caller can always tell the action spine from the privileged
--      ledger.
--   3. RLS IS INHERITED, NOT WIDENED. `security_invoker = on` means the querying
--      user's own RLS on the base tables applies verbatim:
--        • action_audit → org-scoped (aud_select): every org member sees it.
--        • audit_log     → leadership-only (audit_log_read: ceo/coo).
--        • action_requests → org-scoped (ar_select), reached by LEFT JOIN only
--          to resolve action_class + title; a row the caller can't see simply
--          leaves those columns null, it never drops the audit row.
--      So a department_head sees the action spine but NOT the leadership ledger —
--      the rows they may not see never appear, they do not appear blank.
--
-- Applied to project otepdjhrawtqkzclaxbk (migration `audit_feed_view`).

create or replace view public.audit_feed
with (security_invoker = on) as
  -- The action spine: every Review Gate / lifecycle event. action_class + the
  -- request title come from the linked action_request when there is one.
  select
    aa.id,
    'action_audit'::text            as trail,
    aa.org_id,
    aa.created_at,
    aa.event                        as event,
    aa.actor_id                     as actor_user_id,
    aa.actor_role,
    aa.action_request_id,
    ar.action_class                 as action_class,
    ar.title                        as target_title,
    null::text                      as entity_type,
    null::text                      as entity_id,
    null::text                      as ip,
    aa.detail
  from public.action_audit aa
  left join public.action_requests ar on ar.id = aa.action_request_id

  union all

  -- The privileged ledger: role/employment changes, governed deletes, probation
  -- and approval decisions. Leadership-only by the base table's RLS. No action
  -- request to join, so action_class/title stay null; entity + ip carry through.
  select
    al.id,
    'audit_log'::text               as trail,
    al.org_id,
    al.created_at,
    al.action                       as event,
    al.actor_user_id,
    al.actor_role,
    null::uuid                      as action_request_id,
    null::text                      as action_class,
    null::text                      as target_title,
    al.entity_type,
    al.entity_id::text              as entity_id,
    al.ip,
    al.detail
  from public.audit_log al;

comment on view public.audit_feed is
  'Unified read-back of the two audit trails (action_audit + audit_log). '
  'security_invoker: each caller sees only what their base-table RLS allows. '
  'Read-only; no new storage. Powers /audit.';
