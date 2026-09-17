-- Mthryve OS — Migration 0010: Tighten delete RBAC (BUGS R-005 hardening)
-- Deletes were org-wide (any member could delete any task/project). Restrict to
-- the creator or an admin (ceo/coo). Reads and edits remain org-wide for MVP.
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-07.

drop policy projects_delete on projects;
create policy projects_delete on projects for delete
  using (
    org_id = current_org_id()
    and (created_by = auth.uid() or current_user_role() in ('ceo', 'coo'))
  );

drop policy tasks_delete on tasks;
create policy tasks_delete on tasks for delete
  using (
    org_id = current_org_id()
    and (created_by = auth.uid() or current_user_role() in ('ceo', 'coo'))
  );
