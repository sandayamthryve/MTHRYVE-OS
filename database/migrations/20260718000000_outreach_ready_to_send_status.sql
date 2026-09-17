-- Mthryve OS — Migration 20260718000000: outreach_messages 'ready_to_send' status
--
-- ⚑ CTO ACTION REQUIRED — the assistant OWNS this migration but does NOT apply it.
--   Vesper Reach (affiliate AI outreach) needs a 'ready_to_send' state on
--   public.outreach_messages so copy-to-send channels (TikTok DM / Viber / SMS /
--   WhatsApp / FB / IG) can rest, post-approval, as "approved text awaiting a
--   human hand-paste" — distinct from an email that the app will actually send.
--
--   The live CHECK today is:
--     status IN ('draft','approved','sent','failed','no_send_manual')
--   i.e. it LACKS 'ready_to_send'. Until a CTO applies this migration, the app
--   degrades gracefully: approving a copy-channel draft falls back to 'approved'
--   (still fully approved, still copy-to-send in the UI) instead of crashing.
--   Applying this migration upgrades that label to the intended 'ready_to_send'.
--
-- GOVERNING RULES (mirror the rest of the OS):
--   1. Additive + idempotent — only widens the allowed set; existing rows and
--      every current state ('draft'/'approved'/'sent'/'failed'/'no_send_manual')
--      remain valid. Safe to run more than once.
--   2. No data migration, no RLS change, no new column — a single CHECK swap.
--   3. Nothing here sends anything; it only permits the approved-but-unsent
--      resting state the gated send model already relies on.

alter table public.outreach_messages
  drop constraint if exists outreach_messages_status_check;

alter table public.outreach_messages
  add constraint outreach_messages_status_check
  check (status in ('draft', 'approved', 'ready_to_send', 'sent', 'failed', 'no_send_manual'));
