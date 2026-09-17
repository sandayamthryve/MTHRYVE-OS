# Vesper auto-clipping worker

`vesper-clipper.mjs` is the **out-of-runtime** half of Vesper Studio. It does the
work the Vercel app runtime can't: extracting audio, transcribing long audio, and
cutting vertical clips with **ffmpeg**. The app enqueues jobs; this worker drains
them wherever ffmpeg is installed.

Full architecture: [`docs/VESPER_STUDIO.md`](../docs/VESPER_STUDIO.md).

## Requirements

- **node ≥ 20**
- **ffmpeg + ffprobe** on `PATH` (the worker exits with a clear error if missing)
- `@supabase/supabase-js` (already a repo dependency — run from the repo root)

## Environment

```bash
NEXT_PUBLIC_SUPABASE_URL=…
SUPABASE_SERVICE_ROLE_KEY=…    # service-role key — trusted server context only
OPENAI_API_KEY=…              # Whisper transcription
ANTHROPIC_API_KEY=…           # Claude highlight selection
# optional:
VESPER_SEGMENT_MODEL=claude-sonnet-5   # default segmentation model
VESPER_POLL_MS=15000                   # loop poll interval (ms)
VESPER_ONESHOT=1                       # process one job then exit (cron-friendly)
```

## Run

```bash
# from the repo root

# continuous loop:
node worker/vesper-clipper.mjs

# one job per run (systemd timer / cron every minute):
VESPER_ONESHOT=1 node worker/vesper-clipper.mjs
```

## What one job does

1. Claim the oldest `queued` job (guarded update so two workers don't collide).
2. Resolve the source: an existing `media_assets` raw row, or download `source_url`
   into `creative-media/raw` and register it.
3. ffmpeg → mono 16 kHz audio, split into ≤10-minute chunks.
4. OpenAI Whisper (`verbose_json`) per chunk → one timestamped transcript.
5. Anthropic (Claude) → select highlight windows + hook/caption.
6. ffmpeg → cut each highlight to the target aspect (default vertical 1080×1920) +
   a thumbnail.
7. Upload each clip to `creative-media/edited`, insert a `media_assets` row linked to
   the source via `metadata`.
8. Create a `content_items` **draft** (`status='idea'`) + a `short_clip`
   `content_assets` row with the suggested caption.
9. Mark the job `done`.

Nothing publishes — clips are drafts for human review in Creative Studio.
