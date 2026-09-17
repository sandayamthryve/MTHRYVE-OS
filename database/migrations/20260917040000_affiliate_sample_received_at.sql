-- Samples record WHEN they were received.
--
-- The affiliate deck's one buildable rule is a turnaround SLA that starts the
-- clock at sample receipt: sample received -> 72h -> Video 1 -> 48h -> Video 2,
-- with creators chased while they are "approaching or past" it.
--
-- affiliate_samples already stamps requested_at, approved_at, shipped_at and
-- delivered_at. Receipt was the one step in that chain with no timestamp --
-- transitionSample even said so: "'received' and 'rejected' carry no dedicated
-- timestamp column -- status only." So the status could reach 'received' and
-- nothing recorded when, leaving the SLA with nothing to count from.
--
-- updated_at is not a substitute: any later edit to the row moves it, so a
-- countdown built on it silently drifts every time someone corrects a courier.

alter table public.affiliate_samples
  add column if not exists received_at timestamptz;

comment on column public.affiliate_samples.received_at is
  'When the creator received the sample. Starts the content turnaround SLA (72h to Video 1, then 48h to Video 2). Null for samples that have not been received, and for those received before this column existed.';

-- Deliberately NOT backfilled. Rows already at status 'received' have no honest
-- value to take: delivered_at is when it reached the address, not when the
-- creator confirmed, and updated_at is whenever the row was last touched.
-- Inventing either would start real countdowns from fabricated times and chase
-- creators against a deadline nobody set. Those samples read "received, time
-- unknown" and sit outside the SLA until the next one is stamped for real.

-- Partial: only received samples have a clock, and they are the minority of the
-- table at any moment.
create index if not exists affiliate_samples_received_idx
  on public.affiliate_samples(org_id, received_at) where received_at is not null;
