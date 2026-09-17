-- Mthryve OS — Migration 20260716010000: Evidence Capture + Policy Registry
--
-- Backs "Mobile Quick-Entry + Photo/Video Capture" (PASTE 2.1). A phone user
-- snaps a screenshot/photo of a number, Claude vision READS it as a SUGGESTION,
-- the human confirms/edits, and the confirmed number is saved WITH the capture
-- attached as evidence. Vision is never authoritative; nothing auto-saves.
--
-- GOVERNING RULES (mirror the rest of the OS):
--   1. Vision output is a SUGGESTION only. This schema stores the extracted
--      reading (evidence_attachments.vision_extract) alongside the human-typed
--      value; the two never collapse into one "truth". The metric floor still
--      lands in metric_entries.manual_value through the sanctioned manual path —
--      the capture is EVIDENCE hanging off that row, never a second value store.
--   2. Honest nulls. Every optional column is nullable; an unread field is NULL,
--      never a fabricated 0. A video (which vision can't read) simply has a NULL
--      vision_extract.
--   3. Consult policy before a consequential save. policy_registry is the small
--      governance table the save route reads BEFORE writing: it carries the
--      divergence threshold, whether a human must confirm, and whether an
--      auto-save is ever allowed (it is not). One home for that policy, so the UI
--      and the server never disagree on the rule.
--   4. RLS on everything. Reuses current_org_id() / current_user_role().
--      Evidence read = the whole org; write = any org member (a team member on
--      their role home is the primary author), inside their own org folder.
--
-- Idempotent where practical. Fresh timestamp version (the 0026 slot is taken) so
-- the migration runner actually applies it. Applied to project otepdjhrawtqkzclaxbk
-- with this commit.

-- ── PART A.1 — policy_registry ────────────────────────────────────────────────
-- The org's map of "what rule governs a consequential save". Provisioned like the
-- other registries (skill_registry / automation_registry / capabilities) and read
-- through a cast shim on the caller's RLS client. config carries policy-specific
-- knobs; the three columns pulled out are the ones the evidence save enforces on
-- every request.
create table if not exists public.policy_registry (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null default public.current_org_id()
                          references public.organizations(id) on delete cascade,
  key                   text not null,               -- e.g. 'evidence_capture'
  name                  text not null,
  description           text,
  -- Whether a human must explicitly confirm before the save commits. Evidence
  -- capture is always true — vision is a suggestion, never authoritative.
  requires_confirmation boolean not null default true,
  -- Whether the OS may ever commit this save WITHOUT a human in the loop. Kept
  -- false for capture; a true value would let a machine reading self-commit.
  allow_auto_save       boolean not null default false,
  -- Divergence (typed vs machine-read) beyond which the save is FLAGGED for
  -- review. Reuses the metric-mismatch idea at capture time (percent).
  divergence_threshold_pct numeric not null default 10,
  config                jsonb not null default '{}'::jsonb,
  enabled               boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, key)
);

create index if not exists policy_registry_org_key_idx
  on public.policy_registry(org_id, key);

drop trigger if exists policy_registry_set_updated_at on public.policy_registry;
create trigger policy_registry_set_updated_at before update on public.policy_registry
  for each row execute function public.set_updated_at();

alter table public.policy_registry enable row level security;

-- Org read (every surface may consult a policy); leadership-only write (a policy
-- is a governance decision). The save path only ever READS this table.
drop policy if exists policy_registry_org_read on public.policy_registry;
create policy policy_registry_org_read on public.policy_registry for select
  using (org_id = public.current_org_id());

drop policy if exists policy_registry_leadership_write on public.policy_registry;
create policy policy_registry_leadership_write on public.policy_registry for all
  using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  )
  with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo', 'department_head')
  );

-- Seed the capture policy for every existing org. Seeded via cross join (a
-- migration has no auth context, so the current_org_id() default would be NULL).
-- Re-runnable via on conflict do nothing.
insert into public.policy_registry
  (org_id, key, name, description, requires_confirmation, allow_auto_save, divergence_threshold_pct)
select o.id,
       'evidence_capture',
       'Evidence Capture Save',
       'Governs saving a mobile quick-entry with a photo/video/screenshot. A human '
         || 'must confirm the number before it commits; the machine reading is a '
         || 'suggestion only and never auto-saves. A typed value that diverges from '
         || 'the machine reading by more than the threshold is flagged for review.',
       true,   -- requires_confirmation
       false,  -- allow_auto_save
       10      -- divergence_threshold_pct
from public.organizations o
on conflict (org_id, key) do nothing;

-- ── PART A.2 — evidence_attachments ───────────────────────────────────────────
-- One captured artifact (photo/video/screenshot/link) hanging off the daily
-- report, metric entry, or live session it belongs to. vision_extract holds the
-- machine reading as { source, extracted:{metric_key,label,value,unit,...},
-- typed_value, divergence_pct, flagged } — a SUGGESTION recorded next to the
-- human's typed value, never a competing source of truth.
create table if not exists public.evidence_attachments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.current_org_id()
                   references public.organizations(id) on delete cascade,
  -- What this evidence is attached to. entity_id is that row's id (a
  -- metric_entries / live_sessions id, or a daily report id in its own store).
  entity_type    text not null
                   check (entity_type in ('metric_entry', 'daily_report', 'live_session')),
  entity_id      uuid not null,
  url            text not null,                 -- Storage object path ('<org>/<entity_type>/<entity_id>/<file>') or external URL
  kind           text not null default 'photo'
                   check (kind in ('photo', 'video', 'screenshot', 'link')),
  source_url     text,                          -- where the capture came from (a live dashboard URL, share link, …)
  vision_extract jsonb,                         -- the machine reading + divergence; NULL when nothing was read (e.g. a video)
  uploaded_by    uuid default auth.uid() references public.users(id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists evidence_attachments_entity_idx
  on public.evidence_attachments(org_id, entity_type, entity_id);
create index if not exists evidence_attachments_org_created_idx
  on public.evidence_attachments(org_id, created_at desc);

alter table public.evidence_attachments enable row level security;

-- Read: the whole org (evidence backs a shared number). Write: any org member —
-- the quick-entry author is usually a team member on their own role home — but an
-- insert must be stamped as the caller (uploaded_by = auth.uid()) so authorship
-- can't be forged. Update/delete: the author or leadership only.
drop policy if exists evidence_attachments_org_read on public.evidence_attachments;
create policy evidence_attachments_org_read on public.evidence_attachments for select
  using (org_id = public.current_org_id());

drop policy if exists evidence_attachments_member_insert on public.evidence_attachments;
create policy evidence_attachments_member_insert on public.evidence_attachments for insert
  with check (
    org_id = public.current_org_id()
    and uploaded_by = auth.uid()
  );

drop policy if exists evidence_attachments_author_update on public.evidence_attachments;
create policy evidence_attachments_author_update on public.evidence_attachments for update
  using (
    org_id = public.current_org_id()
    and (uploaded_by = auth.uid() or public.current_user_role() in ('ceo', 'coo', 'department_head'))
  )
  with check (
    org_id = public.current_org_id()
    and (uploaded_by = auth.uid() or public.current_user_role() in ('ceo', 'coo', 'department_head'))
  );

drop policy if exists evidence_attachments_author_delete on public.evidence_attachments;
create policy evidence_attachments_author_delete on public.evidence_attachments for delete
  using (
    org_id = public.current_org_id()
    and (uploaded_by = auth.uid() or public.current_user_role() in ('ceo', 'coo', 'department_head'))
  );

-- ── PART A.3 — Private 'evidence' Storage bucket, org-folder scoped ───────────
-- Object path convention: '<org_id>/<entity_type>/<entity_id>/<filename>' — the
-- first path segment is the org, so org scoping is a folder check. Private
-- bucket; captures are never served anonymously. Read = org members; write = any
-- org member, within their own org folder (mirrors evidence_attachments).
insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false)
on conflict (id) do nothing;

drop policy if exists "evidence_bucket_read" on storage.objects;
create policy "evidence_bucket_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

drop policy if exists "evidence_bucket_insert" on storage.objects;
create policy "evidence_bucket_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

drop policy if exists "evidence_bucket_update" on storage.objects;
create policy "evidence_bucket_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  )
  with check (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

drop policy if exists "evidence_bucket_delete" on storage.objects;
create policy "evidence_bucket_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'evidence'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and (public.current_user_role() in ('ceo', 'coo', 'department_head')
         or owner = auth.uid())
  );
