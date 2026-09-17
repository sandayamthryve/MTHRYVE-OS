-- Mthryve OS — Migration 0021: Knowledge Base documents (RAG source)
-- The Knowledge Base is Tony's second memory source: uploaded company documents
-- (SOPs, contracts, playbooks) whose extracted text the grounded assistant can
-- retrieve and CITE. This migration provisions the tables the master brief's
-- Knowledge Base calls for (PROJECT.md §Knowledge Base) so `searchKnowledge()`
-- (lib/knowledge/search.ts) has a real, RLS-scoped table to read from.
--
-- `embedding` is a nullable vector column reserved for pgvector semantic search
-- (ROADMAP M4). It is added only when the `vector` extension is present, so this
-- migration applies cleanly whether or not pgvector has been enabled yet; until
-- then retrieval is keyword-based over `extracted_text`/`title` (still cited).
--
-- RLS mirrors the rest of the OS: org-scoped read/insert/update for any member,
-- delete restricted to leadership + department heads (a source document should
-- not be quietly removed by any team member). Idempotent so the repo stays
-- authoritative even where the table was provisioned live ahead of this file.
-- Applied to project otepdjhrawtqkzclaxbk.

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  uploaded_by uuid references users(id) on delete set null,
  title text not null,
  file_url text,
  file_type text,
  extracted_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists documents_org_idx on documents(org_id);
-- Trigram index makes the keyword ILIKE retrieval in searchKnowledge fast once
-- the corpus grows; guarded so the migration still applies without pg_trgm.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index if not exists documents_text_trgm_idx on documents using gin (extracted_text gin_trgm_ops)';
  end if;
end$$;

-- pgvector embedding column, added only when the extension exists (see header).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    execute 'alter table documents add column if not exists embedding vector(1536)';
  end if;
end$$;

create table if not exists document_tags (
  document_id uuid not null references documents(id) on delete cascade,
  tag text not null,
  primary key (document_id, tag)
);

drop trigger if exists documents_set_updated_at on documents;
create trigger documents_set_updated_at before update on documents
  for each row execute function set_updated_at();

alter table documents enable row level security;
alter table document_tags enable row level security;

drop policy if exists documents_org_select on documents;
create policy documents_org_select on documents for select
  using (org_id = current_org_id());

drop policy if exists documents_org_insert on documents;
create policy documents_org_insert on documents for insert
  with check (org_id = current_org_id() and uploaded_by = auth.uid());

drop policy if exists documents_org_update on documents;
create policy documents_org_update on documents for update
  using (org_id = current_org_id());

drop policy if exists documents_leadership_delete on documents;
create policy documents_leadership_delete on documents for delete
  using (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo', 'department_head')
  );

-- Tags inherit their document's org visibility.
drop policy if exists document_tags_select on document_tags;
create policy document_tags_select on document_tags for select
  using (document_id in (select id from documents where org_id = current_org_id()));

drop policy if exists document_tags_insert on document_tags;
create policy document_tags_insert on document_tags for insert
  with check (document_id in (select id from documents where org_id = current_org_id()));

drop policy if exists document_tags_delete on document_tags;
create policy document_tags_delete on document_tags for delete
  using (document_id in (select id from documents where org_id = current_org_id()));
