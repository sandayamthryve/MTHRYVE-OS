-- Migration 20260730000000 — metric_brief_cache: persist the Mission Control
-- per-metric AI blurbs (WHY / POTENTIAL IMPACT) so the dashboard NEVER calls the
-- model during render.
--
-- WHY THIS EXISTS: loadMetricBriefs used to call claude-opus-4-8 INLINE during
-- Command Center render (wrapped in unstable_cache, but a stale/expired key or a
-- changed figure re-ran the model on the request path with a 12s timeout). Live
-- Vercel logs (Jul 28–29) showed ~590 blocking failures of
-- "mission-control-metric-briefs-v1" — 512× "model call timed out" and 78× "API
-- usage limits reached" — surfaced across /csi, /search, /contracts, /tony via
-- RSC prefetch of the dashboard. That was the CEO's "hangs".
--
-- THE FIX: render reads the LAST CACHED blurb from this table (a fast org-scoped
-- select, never a model call); a BACKGROUND job (the GitHub Actions scheduler →
-- /api/automation/metric-briefs) regenerates the blurbs with the cheapest model
-- and upserts them here. Narrative may be cached (this table); the FIGURES on the
-- tiles are always read live and are NOT stored here (doctrine).
--
-- Additive and backward-compatible: old code never touched this table, and the
-- render degrades to "—" when a row is absent. Idempotent / re-runnable.
--
-- Applied to project otepdjhrawtqkzclaxbk together with this commit.

create table if not exists public.metric_brief_cache (
  org_id       uuid not null default public.current_org_id()
                 references public.organizations (id) on delete cascade,
  -- The MetricKey from lib/briefings/metric-briefs.ts (health / revenue / cash /
  -- cognition / revenuePulse / gmvPlatform). Narrow text, not an enum, so adding a
  -- future tile needs no migration.
  metric_key   text not null,
  -- AI-generated, grounded ONLY in the real figures at refresh time. The tile's
  -- number is NOT here — it is always read live.
  why          text not null,
  impact       text not null,
  -- Which model wrote this blurb (audit / cost trail).
  model        text,
  -- When the background job last wrote this blurb. Blurbs are ALLOWED to age; the
  -- render always serves the last value regardless of age.
  refreshed_at timestamptz not null default now(),
  primary key (org_id, metric_key)
);

comment on table public.metric_brief_cache is
  'Last-known Mission Control per-metric AI blurbs (why/impact). Read on render (never a model call); written by the background refresh (/api/automation/metric-briefs). Narrative only — figures are always read live.';

alter table public.metric_brief_cache enable row level security;

-- Read: any member of the caller''s org — EXCEPT the cash-flow blurb, which stays
-- leadership-only (ceo/coo), mirroring the render''s canSeeCash gate so the cash
-- narrative is never exposed to a non-leadership org member via a direct read.
create policy metric_brief_cache_select on public.metric_brief_cache
  for select using (
    org_id = public.current_org_id()
    and (metric_key <> 'cash' or public.current_user_role() in ('ceo', 'coo'))
  );

-- No INSERT / UPDATE / DELETE policies on purpose: the ONLY writer is the
-- background refresh, which runs with the service-role key and bypasses RLS.
-- A user client can read (above) but never write.
