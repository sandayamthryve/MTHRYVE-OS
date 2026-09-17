-- Migration 0021: Knowledge base file storage ('documents' bucket)
--
-- The RAG tables (public.documents, public.document_chunks) and the
-- match_document_chunks() retrieval function already exist on the live project
-- (created out-of-band; NOT re-declared here — no RAG schema change). What was
-- missing was the private Storage bucket that holds the ORIGINAL uploaded files
-- (pdf/docx/txt/md) that ingestion extracts + chunks + embeds.
--
-- SECURITY MODEL — mirrors the documents table RLS exactly:
--   • Bucket is PRIVATE (public = false); files are never served anonymously.
--   • Object path convention: '<org_id>/<document_id>/<filename>'. The first
--     path segment is the org, so org scoping is a folder check.
--   • WRITE (upload / overwrite / delete) = ceo / coo / department_head, and
--     only within their own org's folder — the same roles the documents_write
--     RLS policy allows.
--   • READ (download the raw original) = org members, but 'leadership'
--     sensitivity files only for ceo / coo. This mirrors documents_select via a
--     join on storage_path so the raw file is never more visible than its
--     chunks. Ingestion itself downloads with the service-role key (bypasses
--     RLS), so it never depends on these policies.
--
-- Idempotent: safe to re-apply. current_org_id() / current_user_role() are the
-- same SECURITY DEFINER helpers the table policies use.

-- 1. The private bucket.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- 2. Policies on storage.objects, scoped to this bucket.

-- READ: org members; leadership-only files gated to ceo/coo. Mirrors
-- public.documents.documents_select by joining back on storage_path = name.
drop policy if exists "documents_bucket_read" on storage.objects;
create policy "documents_bucket_read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1
      from public.documents d
      where d.storage_path = storage.objects.name
        and d.org_id = current_org_id()
        and (d.sensitivity = 'org' or current_user_role() in ('ceo', 'coo'))
    )
  );

-- WRITE — split into insert / update / delete so SELECT stays governed solely
-- by the sensitivity-aware read policy above (an ALL policy would also grant
-- read). All three require a write role and the object to live in the caller's
-- own org folder.
drop policy if exists "documents_bucket_insert" on storage.objects;
create policy "documents_bucket_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = current_org_id()::text
    and current_user_role() in ('ceo', 'coo', 'department_head')
  );

drop policy if exists "documents_bucket_update" on storage.objects;
create policy "documents_bucket_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = current_org_id()::text
    and current_user_role() in ('ceo', 'coo', 'department_head')
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = current_org_id()::text
    and current_user_role() in ('ceo', 'coo', 'department_head')
  );

drop policy if exists "documents_bucket_delete" on storage.objects;
create policy "documents_bucket_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = current_org_id()::text
    and current_user_role() in ('ceo', 'coo', 'department_head')
  );
