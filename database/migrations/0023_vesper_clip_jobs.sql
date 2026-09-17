-- Mthryve OS — Migration 0023: Vesper Studio auto-clipping job queue
-- Vesper Studio (V4) turns a livestream / long video into short-form clip
-- DRAFTS. Video processing (ffmpeg) and long-audio transcription cannot run in
-- the Vercel serverless runtime (no ffmpeg binary; function time/memory/body
-- limits), so the pipeline is a QUEUED JOB processed by an out-of-runtime worker
-- (see worker/vesper-clipper.mjs + docs/VESPER_STUDIO.md). This table IS the
-- queue and the per-job ledger; the worker claims rows with the SERVICE ROLE
-- (bypassing RLS, scoping every write by row id), the same pattern the fal
-- completion writer uses.
--
-- What this migration does NOT need to change (audited against the live schema):
--   • media_assets already has folder='edited' (CHECK) and a metadata jsonb — so
--     each cut clip is a media_assets row (folder 'edited') whose metadata links
--     back to the source asset + this job + its start/end. No new columns.
--   • content_assets.kind / .status are plain text (no CHECK) — so clip drafts
--     use kind='short_clip', status='draft' with no constraint change.
-- The only new object is this job table.
--
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-14.

create table if not exists vesper_clip_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade default current_org_id(),
  brand_id uuid references brands(id) on delete set null,

  -- The source long-form video. source_asset_id points at the raw media_assets
  -- row when the source is already in the bucket; source_url carries an external
  -- URL the worker fetches, stores into creative-media/raw, then back-fills
  -- source_asset_id. At least one is always set (enforced below).
  source_asset_id uuid references media_assets(id) on delete set null,
  source_url text,
  source_title text,

  -- Pipeline state machine. The worker advances this in order; terminal states
  -- are 'done' / 'failed' / 'canceled'.
  status text not null default 'queued'
    check (status in ('queued','transcribing','segmenting','clipping','drafting','done','failed','canceled')),
  stage_detail text,          -- human-readable "what's happening now"
  error text,                 -- last error when status='failed'

  -- Tunables the requester chose (max_clips, min/max clip seconds, aspect).
  options jsonb not null default '{}'::jsonb,

  -- Artifacts the pipeline produces, kept on the job for auditability + re-runs.
  transcript jsonb,           -- [{ start, end, text }] timestamped cues
  segments jsonb,             -- selected highlights [{ start, end, hook, caption, ... }]
  clips_created integer not null default 0,

  -- Provenance: which services actually did the work (honest attribution).
  transcript_service text,    -- e.g. 'openai-whisper'
  segment_model text,         -- the Anthropic model id used for selection

  requested_by uuid references users(id) on delete set null,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vesper_clip_jobs_has_source
    check (source_asset_id is not null or source_url is not null)
);

-- Worker claim ordering + org listing.
create index if not exists vesper_clip_jobs_status_idx
  on vesper_clip_jobs(status, created_at);
create index if not exists vesper_clip_jobs_org_idx
  on vesper_clip_jobs(org_id, created_at desc);
create index if not exists vesper_clip_jobs_source_idx
  on vesper_clip_jobs(source_asset_id);

create trigger vesper_clip_jobs_set_updated_at before update on vesper_clip_jobs
  for each row execute function set_updated_at();

alter table vesper_clip_jobs enable row level security;

-- Any authed org member may enqueue, read and update their org's jobs (the
-- worker uses the service role, which bypasses RLS entirely). Deletes are not
-- exposed — a finished job is history; cancel by setting status='canceled'.
create policy vesper_clip_jobs_select on vesper_clip_jobs for select
  using (org_id = current_org_id());
create policy vesper_clip_jobs_insert on vesper_clip_jobs for insert
  with check (org_id = current_org_id());
create policy vesper_clip_jobs_update on vesper_clip_jobs for update
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
