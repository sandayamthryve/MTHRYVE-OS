-- Outreach messages can name the campaign they invite a creator to.
--
-- The affiliate deck's Activation stage is "send campaign invites to creators
-- through the platform", and Campaign Invite is one of the key terms the team
-- uses daily. The app could send outreach but never record which campaign it
-- was for, so no stored message could honestly be called an invite to a
-- specific campaign — the term was carried as guidance-only in
-- lib/affiliate/vocabulary.ts for exactly this reason.
--
-- References op_records, not campaigns: an affiliate campaign IS an op_record
-- with record_type = 'campaign' (see 0025_operational_records.sql), which is
-- what affiliate_samples and affiliate_content already point at. Pointing this
-- column at the other table would have made outreach the one place that
-- disagreed about what a campaign is.

alter table public.outreach_messages
  add column if not exists campaign_id uuid references public.op_records(id) on delete set null;

comment on column public.outreach_messages.campaign_id is
  'The campaign this message invites the creator to, as an op_record with record_type = ''campaign''. Null for general outreach, which is most of it — a message only becomes a campaign invite by naming one.';

-- A foreign key cannot require record_type = 'campaign' (op_records also holds
-- promotions, missions and rewards). The server action only offers campaigns
-- and re-checks the chosen id before writing, so a non-campaign id is rejected
-- there rather than silently stored. A trigger would be the stricter fix and is
-- deliberately not taken: it would fire on every outreach write to guard a
-- column the UI cannot set wrongly.

-- Partial: most outreach names no campaign, so indexing the nulls would be dead
-- weight on a column whose whole point is being sparse.
create index if not exists outreach_messages_campaign_idx
  on public.outreach_messages(org_id, campaign_id) where campaign_id is not null;
