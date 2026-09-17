# Vesper Studio — in-house auto-clipping pipeline

**What it does.** Turns a livestream / long video into reviewable **short-form clip
drafts**: transcribe → find highlights → cut vertical clips → drop each into
Creative Studio as a draft with a suggested hook + caption. **Nothing publishes
automatically** — every clip lands as an `idea` content item for a human to review
and publish through the existing Produce flow.

This reuses the already-provisioned `creative-media` bucket and `media_assets`
table, and the Creative Studio content engine. The only new database object is the
job queue (`vesper_clip_jobs`, migration `0023`).

---

## Why there is a separate worker (the honest limit)

The heavy stages — extracting audio, transcribing long audio, and cutting /
re-encoding vertical clips — need **ffmpeg** and minutes of CPU/RAM per job. None of
that can run in the Vercel serverless runtime:

- **No ffmpeg binary** in the Node serverless runtime (and no room to ship one).
- **Function limits** — max duration, memory, and request-body caps make full-length
  video processing infeasible; a 45-minute livestream would blow every budget.

So the pipeline is a **queued job model**. The Next.js app enqueues jobs and runs
the one stage that is a pure API call (Anthropic segment selection); a **standalone
worker** (`worker/vesper-clipper.mjs`) does the media work wherever ffmpeg is
installed — a small VM, a container, a cron box, or a developer machine. The worker
talks to Supabase with the **service role** (no user session), scoping every write
by row id — the same pattern the fal completion writer already uses.

```
┌────────────────────────── Next.js app (Vercel) ──────────────────────────┐
│  Creative Studio ▸ Vesper tab                                             │
│    • enqueue a job (raw media_asset OR url)   → POST /api/vesper/ingest    │
│    • poll status / list clip drafts           → GET  /api/vesper/jobs/[id] │
│    • run Anthropic segment selection in-app   → POST /api/vesper/jobs/[id]/segment
│  vesper_clip_jobs (queue, RLS-scoped)                                      │
└───────────────▲───────────────────────────────────────────┬──────────────┘
                │ claim (service role)                       │ writes drafts back
                │                                            ▼
┌───────────────┴──────── worker/vesper-clipper.mjs (has ffmpeg) ───────────┐
│  1. claim next 'queued' job (guarded update)                              │
│  2. download source from creative-media/raw  (or fetch source_url first)  │
│  3. ffmpeg → extract mono 16k audio, split into ≤10-min chunks            │
│  4. OpenAI Whisper (verbose_json) per chunk → timestamped transcript      │
│  5. Anthropic (Claude) → select highlight windows + hook/caption          │
│  6. ffmpeg → cut each highlight to vertical 1080×1920 (+ thumbnail)       │
│  7. upload clip → creative-media/edited ; insert media_assets row         │
│  8. create content_items DRAFT + short_clip content_assets row            │
│  9. status → done (clips_created = N)                                     │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Which service does what (attribution)

| Stage | Service | Where it runs |
|-------|---------|---------------|
| Transcription | **OpenAI Whisper** (`whisper-1`, `verbose_json` w/ segment timestamps) | Worker (needs audio → needs ffmpeg) |
| Highlight **segment selection** | **Anthropic** (Claude — model by role tier in-app, `VESPER_SEGMENT_MODEL` in the worker) | In-app **and** worker |
| Clipping / re-encode | **ffmpeg** | Worker only |
| Drafting (item + caption) | Creative Studio content engine (`content_items` / `content_assets`) | Worker (service role) |

No new paid keys: transcription reuses `OPENAI_API_KEY` (already powering Tony's
voice + Knowledge embeddings) and segmentation reuses `ANTHROPIC_API_KEY`.

---

## Data model

**`vesper_clip_jobs`** (new — migration `0023`) is the queue + per-job ledger. State
machine: `queued → transcribing → segmenting → clipping → drafting → done` (terminal:
`done` / `failed` / `canceled`). It stores the `transcript` and selected `segments`
as jsonb for auditability and re-runs, plus honest provenance
(`transcript_service`, `segment_model`). RLS mirrors the rest of the app
(`current_org_id()`); the worker uses the service role.

**No changes to `media_assets` or `content_assets` were needed** (audited against the
live schema):

- Cut clips are ordinary `media_assets` rows in the **`edited`** folder (already
  allowed by the `folder` CHECK). Each links back to its source + job + in/out points
  via the existing `metadata` jsonb — no new columns.
- Clip drafts are `content_assets` rows with `kind = 'short_clip'`,
  `provider = 'vesper'`, `status = 'draft'`. `content_assets.kind`/`.status` are plain
  `text` (no CHECK), so this needed no constraint change — only the app's display
  vocabulary in `lib/content/assets.ts` was extended so the Library/Kit render it.

---

## Running the worker

Requires **node ≥ 20**, **ffmpeg + ffprobe** on `PATH`, and these env vars:

```
NEXT_PUBLIC_SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…      # service role — server-trusted only, never client
OPENAI_API_KEY=…                 # Whisper transcription
ANTHROPIC_API_KEY=…              # segment selection
# optional:
VESPER_SEGMENT_MODEL=claude-sonnet-5   # default
VESPER_POLL_MS=15000                   # loop poll interval
VESPER_ONESHOT=1                       # process one job then exit (for cron)
```

```bash
# long-running loop:
node worker/vesper-clipper.mjs
# or one job per invocation (e.g. a per-minute cron / systemd timer):
VESPER_ONESHOT=1 node worker/vesper-clipper.mjs
```

The worker fails fast with a clear message if ffmpeg/ffprobe are missing.

---

## Using it

1. **Ingest.** In Creative Studio → **Vesper** tab, upload a long video to the
   Library's *Raw Files* folder (or paste a URL), then queue an auto-clip job (pick
   max clips + aspect). This only writes a `queued` job — no video is touched in the
   app runtime.
2. **Process.** The worker picks the job up, transcribes, asks Claude for highlights,
   cuts vertical clips, and stores them.
3. **Review.** Each clip appears in the Vesper tab (play + "Review draft →") and in
   **Produce** as an `idea` content item with the suggested hook/caption in its brief,
   and in the **Library** as a `short_clip` asset. A human edits and publishes through
   the normal flow. **Nothing auto-publishes.**

`GET /api/vesper/diag` reports which services are configured (without spending).

---

## Phase 2 — serverless transcribe + segment (GitHub Actions-driven)

Phase 1 shipped the signed **direct replay upload** (browser → Cloudinary → a
`queued` `vesper_clip_jobs` row). Phase 2 adds the "brain": two
**automation-bearer** routes that GitHub Actions polls on a schedule, each advancing **one
job by one stage**, with **no ffmpeg and no rendering**. The pipeline for a
Cloudinary-hosted replay now runs entirely in the Vercel runtime up to a
transcript + segment plan:

```
queued ──POST /api/vesper/transcribe──▶ transcribing ──(ok)──▶ segmenting
segmenting ──POST /api/vesper/segment──▶ drafting            (ends here — Phase 3 renders)
        └─ any error on either stage ─▶ failed (+ error, never hangs)
```

**Why this can skip ffmpeg (the Phase-1 worker couldn't):** the replay already
lives on Cloudinary, so we ask **Cloudinary** to deliver a small mono/16 kHz MP3
of the audio track via a URL transform
(`/video/upload/ac_mono,af_16000,q_auto:low/…​.mp3`) and hand *that* to Whisper.
No local audio extraction, so it fits the serverless limits. A ~45-min replay is
~20 MB of audio — under Whisper's 25 MB cap; anything larger **fails honestly**
(`audio-too-large`) so it's routed to the ffmpeg worker instead of silently
truncated.

| Route | Auth | Claims | Does | On success | On error |
|-------|------|--------|------|-----------|----------|
| `POST /api/vesper/transcribe` | `AUTOMATION_API_KEY` bearer | oldest `queued` (guarded CAS → `transcribing`, `claimed_at`) | Whisper `verbose_json` on the Cloudinary audio → `transcript` + `transcript_service` | → `segmenting` | → `failed` + `error` |
| `POST /api/vesper/segment` | `AUTOMATION_API_KEY` bearer | oldest `segmenting` (guarded CAS → `drafting`) | Anthropic picks 3–5 **sellable** windows → `segments` + `segment_model` | stays `drafting` | → `failed` + `error` |

- **Guarded claim (no double-run).** Each claim is a compare-and-swap
  (`update … where status = <prev>`); a second poller that loses the race matches
  zero rows and no-ops. Same pattern as the worker.
- **Honest status only.** The vocab is exactly
  `queued → transcribing → segmenting → drafting → done` (or `failed`); a failed
  job always carries an `error` and never hangs.
- **Cost breadcrumbs before scaling.** Transcript **minutes** + audio **bytes**
  (transcribe) and model **token usage** (segment) are logged and merged into
  `options._cost`, so per-job cost is visible before turning the volume up.
- **Service role, cross-org.** Both routes use the service-role client (no user
  session) and process the queue across orgs — like the worker.

These reuse the same providers as the worker (`OPENAI_API_KEY` for Whisper,
`ANTHROPIC_API_KEY` for selection) and the shared `AUTOMATION_API_KEY` gate that
already guards the other `/api/automation` routes. `VESPER_SEGMENT_MODEL`
(default `claude-sonnet-5`) picks the selection model. Phase 3 will pick up
`drafting` jobs and render the clips.

---

## Current limitations / next iterations

- The worker is the out-of-runtime dependency; it must be deployed somewhere with
  ffmpeg (not Vercel). A container image + a health/heartbeat surface is a natural
  follow-up.
- Clip playback uses time-boxed Supabase signed URLs (the bucket is private); the UI
  re-signs on each load. A CDN/public-preview variant could be added later.
- Highlight selection quality depends on transcript quality; very noisy audio or
  heavy Taglish code-switching may need prompt tuning (Whisper auto-detects language).
- Face-tracking / auto-reframe and burned-in captions are not in this iteration —
  clips are center-cropped to the target aspect.
