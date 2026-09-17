-- Expense attachments — the supporting documents an expense is justified by.
--
-- The calibration report: "ORs, sales invoices, POs, delivery receipts,
-- quotations, contracts and payment confirmations — PDF, JPG, PNG, DOCX, XLSX",
-- and attachment history in the immutable audit trail.
--
-- The row records the object; the bytes live in Supabase Storage under the
-- org-scoped path lib/expenses/attachments.ts builds. Two facts follow from
-- that split: the path is unique (two rows must never claim one object), and
-- deleting a row must not silently orphan bytes — the upload route removes the
-- object when the row write fails, and a detach records itself in the trail.

create table if not exists public.expense_attachments (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  expense_id uuid not null references expenses(id) on delete cascade,
  -- What the document IS, as distinct from what the file is. A payment
  -- confirmation may be a PDF or a screenshot, so the two are separate axes.
  kind text not null default 'other' check (kind in (
    'official_receipt', 'sales_invoice', 'purchase_order', 'delivery_receipt',
    'quotation', 'contract', 'payment_confirmation', 'other'
  )),
  -- The name as uploaded, already sanitised by safeFilename(). Kept so the
  -- download can be offered under the name finance recognises.
  file_name text not null,
  -- Canonical type from the extension allowlist, never the browser's claim.
  content_type text not null check (content_type in (
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 15 * 1024 * 1024),
  storage_path text not null,
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- One row per object. Without this a retry could double-record one upload.
  constraint expense_attachments_path_uq unique (storage_path)
);

create index if not exists expense_attachments_expense_idx
  on public.expense_attachments(expense_id, created_at desc);

comment on table public.expense_attachments is
  'Supporting documents for an expense. Bytes live in storage; this row is the record of them.';

-- ── Attachment history ──────────────────────────────────────────────────────
-- The report wants attachment history inside the same immutable trail as the
-- rest of the expense, so attaching and detaching write there rather than
-- keeping a private log nobody reviews alongside the approvals.
create or replace function public.expense_attachments_write_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.expense_audit (org_id, expense_id, action, actor_id, updated_values, note)
    values (new.org_id, new.expense_id, 'attachment:added', new.uploaded_by,
            to_jsonb(new), new.file_name);
    return new;
  end if;

  insert into public.expense_audit (org_id, expense_id, action, actor_id, previous_values, note)
  values (old.org_id, old.expense_id, 'attachment:removed', auth.uid(),
          to_jsonb(old), old.file_name);
  return old;
end;
$$;

drop trigger if exists expense_attachments_audit_trg on public.expense_attachments;
create trigger expense_attachments_audit_trg
  after insert or delete on public.expense_attachments
  for each row execute function public.expense_attachments_write_audit();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Readable by the org, like the ledger rows they belong to. Written by the
-- roles that may encode, because attaching the receipt is part of encoding.
-- There is no UPDATE policy: an attachment is added or removed, never edited —
-- silently repointing a row at different bytes would defeat the trail.
alter table public.expense_attachments enable row level security;

drop policy if exists expense_attachments_select on public.expense_attachments;
create policy expense_attachments_select on public.expense_attachments for select
  using (org_id = current_org_id());

drop policy if exists expense_attachments_insert on public.expense_attachments;
create policy expense_attachments_insert on public.expense_attachments for insert
  with check (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo', 'department_head')
    -- The attachment must belong to an expense in the caller's own org; without
    -- this, a valid org_id plus a foreign expense_id would cross the boundary.
    and exists (
      select 1 from public.expenses e
      where e.id = expense_id and e.org_id = current_org_id()
    )
  );

drop policy if exists expense_attachments_delete on public.expense_attachments;
create policy expense_attachments_delete on public.expense_attachments for delete
  using (org_id = current_org_id() and current_user_role() in ('ceo', 'coo'));
