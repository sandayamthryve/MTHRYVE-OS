-- Migration 20260728020000 — one OPEN live session per anchor (idempotency backstop).
--
-- PR 6 adds a mobile-first ONE-TAP "START LIVE" capture (app/(dashboard)/live):
-- someone mid-stream, hands full, taps once and a live_sessions row is born with
-- status='live', started_at=now, source='manual', external_id=NULL. The action
-- already refuses to open a second session for an anchor that is already live,
-- but a double-tap can race that check. This partial unique index is the DB-level
-- backstop that makes the guarantee hard: an anchor can have AT MOST ONE row in
-- status='live' per org at any instant.
--
--   • Partial (WHERE status = 'live'): only OPEN sessions are constrained. An
--     anchor can accumulate any number of 'ended'/'scheduled' rows over time —
--     history is never blocked, only a duplicate CONCURRENT live is.
--   • anchor_id IS NOT NULL: a session logged without a host is never deduped
--     (mirrors the anchors handle-uniqueness convention, where NULLs are distinct).
--   • Does NOT touch the reserved sync key live_sessions_org_id_external_id_key
--     (org_id, external_id): manual rows carry external_id=NULL and stay distinct
--     there, so a future TikTok API feed can never collide with a hand-tapped row.
--
-- Additive + idempotent (IF NOT EXISTS); no data change. Any pre-existing double
-- open for one anchor would block creation — there are none today (0 live rows),
-- and the app-level guard has always prevented them.

create unique index if not exists live_sessions_one_open_per_anchor
  on public.live_sessions (org_id, anchor_id)
  where status = 'live' and anchor_id is not null;

comment on index public.live_sessions_one_open_per_anchor is
  'Backstop for the one-tap START LIVE capture: at most one status=''live'' session per (org, anchor) at a time. Partial on open sessions only; history is unconstrained. Manual rows keep external_id NULL so they never collide with the reserved (org_id, external_id) sync key.';
