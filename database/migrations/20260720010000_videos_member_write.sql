-- Mthryve OS — Migration: videos member INSERT/UPDATE (additive)
--
-- ACCESS RECONCILIATION — videos RLS rider. The Live & Video Wall is an OPERATING
-- TOOL: every org member should be able to POST and EDIT a video, exactly as they
-- already can with content_items on the Content Calendar / Creative Studio. Until
-- now public.videos only had:
--   • videos_read  (SELECT, org-scoped)                    — whole org reads
--   • videos_write (ALL,    org + ceo/coo/department_head) — leadership writes only
-- so a team_member could see the library but never add or edit a video.
--
-- This rider adds org-scoped INSERT + UPDATE policies that MIRROR the existing
-- content_items_insert / content_items_update policies VERBATIM (same role target —
-- PUBLIC — and the same `org_id = current_org_id()` check). Because RLS permissive
-- policies OR together, a member's write now passes via these while leadership keeps
-- passing via videos_write.
--
-- DELETE is deliberately UNCHANGED: no DELETE policy is added, so the only policy
-- that admits a DELETE remains videos_write (ALL) — i.e. DELETE stays leadership
-- (ceo/coo/department_head). The UI mirrors this (the ✕ hard-delete + the governed
-- "Request deletion" control are hidden below leadership on the wall).
--
-- SCOPE GUARDRAIL: these two videos policies are the ONLY RLS change. No other
-- table is touched. live_sessions is already org-writable (live_sessions_org_write)
-- and is left exactly as it is. Idempotent (drop-if-exists + create). Applied to
-- project otepdjhrawtqkzclaxbk with this commit.
--
-- Reference — the policies being mirrored, as they exist on content_items today:
--   content_items_insert : INSERT, roles {public}, with check (org_id = current_org_id())
--   content_items_update : UPDATE, roles {public}, using      (org_id = current_org_id())

-- videos INSERT — mirrors content_items_insert (org-scoped, role target PUBLIC).
drop policy if exists videos_insert on public.videos;
create policy videos_insert on public.videos
  for insert
  with check (org_id = public.current_org_id());

-- videos UPDATE — mirrors content_items_update (org-scoped, role target PUBLIC).
-- No separate with_check: for UPDATE, Postgres reuses the USING expression as the
-- row check, exactly as content_items_update relies on.
drop policy if exists videos_update on public.videos;
create policy videos_update on public.videos
  for update
  using (org_id = public.current_org_id());

-- NOTE: videos_write (ALL) is intentionally NOT dropped or altered — it is what
-- keeps DELETE (and the leadership write path) gated to ceo/coo/department_head.
