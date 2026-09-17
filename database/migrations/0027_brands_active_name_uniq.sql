-- Mthryve OS — Migration 0027: unique active client name per org (dup guard)
--
-- Defense-in-depth backstop for the Clients editor. The application already
-- guarantees that:
--   • saving an edit UPDATEs the opened brand by id (never inserts), and
--   • "Add a client" blocks a second active brand with the same normalized name.
-- This index makes the invariant impossible to violate at the data layer even if
-- a future code path, race, or manual write tries to: no two non-archived brands
-- in the same org may share a case-insensitive name.
--
-- Predicate is `status <> 'archived'` so archived (retired) clients don't block
-- reusing a name later, and so the index matches the app's "active" definition.
--
-- PRECONDITION: any existing duplicate active row MUST be removed first, or this
-- index creation fails. The known duplicate — an empty second "BodegaTrends"
-- (id 97dadc0f-adaa-4451-a74b-0dec288b1bad) — is deleted ahead of this migration.
--
-- Applied to project otepdjhrawtqkzclaxbk.

create unique index if not exists brands_org_active_name_uniq
  on public.brands (org_id, lower(name))
  where status <> 'archived';

comment on index public.brands_org_active_name_uniq is
  'No two non-archived brands per org may share a case-insensitive name. Backstop for the Business Development Clients editor duplicate guard.';
