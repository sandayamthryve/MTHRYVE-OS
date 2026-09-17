-- Mthryve OS — Migration 20260720030000: Lean Outreach Bridge (Gmail-merge loop)
--
-- The $0, no-ESP, no-subscription, no-auto-send outreach bridge. The OS is the
-- BRAIN (draft → approve → track); the team's existing FREE Gmail / Apps Script
-- mail-merge is the HANDS (the actual send). This migration adds the minimal,
-- ADDITIVE columns that let an approved batch be EXPORTED as a merge-ready CSV
-- and its RESULTS re-IMPORTED to close the loop — for BOTH audiences through the
-- one recipient-agnostic engine: creators (recipient_type='creator') and client
-- leads (recipient_type='lead').
--
-- GOVERNING RULES (mirror the rest of the OS):
--   1. Additive + idempotent — only ADD columns / widen a CHECK; every existing
--      row and state stays valid. Safe to run more than once.
--   2. No auto-send, no ESP, no new cost. Nothing here sends anything: these
--      columns only record the human-run merge's lifecycle (exported → the team
--      sends via Gmail → results imported).
--   3. RLS UNCHANGED. Both tables already enable RLS with org-scoped policies
--      (outreach_messages_org_read/write/update, leads_select/insert/update).
--      New columns inherit those policies — no policy change is needed or made.
--   4. The approve / export / import ACTIONS write public.audit_log from the app
--      layer (service-role, unforgeable) — see lib/outreach/bridge-actions.ts.
--      No DB trigger is added; the app is the single audit writer, as elsewhere.
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ── outreach_messages: batch label + export stamp + delivery lifecycle ─────────
-- delivery_status is DISTINCT from the existing workflow `status`
-- (draft/approved/ready_to_send/sent/…): `status` is the approval/send workflow;
-- delivery_status tracks the Gmail-merge OUTCOME re-imported from the result CSV
-- (exported → sent → opened → replied, or bounced / opted_out). A fresh row is
-- 'draft'; approval moves it to 'approved'; export stamps 'exported'; the results
-- import advances it to the real outcome.
alter table public.outreach_messages
  add column if not exists batch_label   text;

alter table public.outreach_messages
  add column if not exists exported_at   timestamptz;

alter table public.outreach_messages
  add column if not exists delivery_status text not null default 'draft';

alter table public.outreach_messages
  drop constraint if exists outreach_messages_delivery_status_check;

alter table public.outreach_messages
  add constraint outreach_messages_delivery_status_check
  check (delivery_status in (
    'draft', 'approved', 'exported', 'sent',
    'opened', 'replied', 'bounced', 'opted_out'
  ));

-- Fast lookups for the approval list (by recipient_type + delivery_status) and
-- for matching an imported result row back to its exported batch (by batch_label).
create index if not exists outreach_messages_type_delivery_idx
  on public.outreach_messages (org_id, recipient_type, delivery_status);

create index if not exists outreach_messages_batch_idx
  on public.outreach_messages (org_id, batch_label);

-- ── leads: do-not-contact suppression flags ───────────────────────────────────
-- The pre-export hard filter and the results-import opt-out/bounce handling need
-- a durable "never contact this lead again" flag. Creators already carry their
-- own lifecycle (status / outreach_stage) and are suppressed via a prior
-- opted_out/bounced message, so these two columns live only on leads (per spec).
alter table public.leads
  add column if not exists do_not_contact boolean not null default false;

alter table public.leads
  add column if not exists opted_out_at    timestamptz;

create index if not exists leads_do_not_contact_idx
  on public.leads (org_id, do_not_contact);

-- ── leads.stage: allow 'in_conversation' (a reply advances a lead here) ────────
-- The results import advances a lead to 'in_conversation' when the merge reports
-- a REPLY. The live CHECK lacked that value, so we WIDEN it (only adds a value —
-- every existing stage stays valid). Kept idempotent (drop + re-add).
alter table public.leads
  drop constraint if exists leads_stage_check;

alter table public.leads
  add constraint leads_stage_check
  check (stage in (
    'new', 'contacted', 'in_conversation', 'qualified', 'proposal', 'won', 'lost'
  ));
