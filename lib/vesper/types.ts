// Vesper Studio (V4) — shared vocabulary for the in-house auto-clipping pipeline
// that turns a livestream / long video into short-form clip DRAFTS. Kept
// dependency-free so both the Next.js app (server routes + Creative Studio UI)
// and the standalone worker's TypeScript-facing callers agree on the shapes.
//
// Pipeline (see docs/VESPER_STUDIO.md):
//   ingest → transcribe → segment (Anthropic) → clip (ffmpeg) → draft → review
//
// Runtime split: transcription + ffmpeg clipping run ONLY in the out-of-runtime
// worker (worker/vesper-clipper.mjs); the app enqueues jobs, runs the Anthropic
// segment selection (a pure API call, testable in-app), reads status, and
// surfaces the resulting drafts in Creative Studio.

// The job state machine. Advanced in order by the worker; terminal states are
// 'done' | 'failed' | 'canceled'. Mirrors the CHECK in migration 0023.
export const JOB_STATUSES = [
  "queued",
  "transcribing",
  "segmenting",
  "clipping",
  "drafting",
  "done",
  "failed",
  "canceled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// Non-terminal states the worker still has work to do on.
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "transcribing",
  "segmenting",
  "clipping",
  "drafting",
];

// The content_assets kind + status used for a clip draft. content_assets.kind
// and .status are plain text in the DB (no CHECK), so these are app-level
// conventions, mirrored into lib/content/assets.ts so the Library/Kit render
// them with a label + icon.
export const VESPER_PROVIDER = "vesper";
export const SHORT_CLIP_KIND = "short_clip";
export const CLIP_DRAFT_STATUS = "draft";

// Cut clips land in the existing media_assets 'edited' folder (already allowed by
// the folder CHECK). Sources are read from the 'raw' folder.
export const SOURCE_FOLDER = "raw";
export const CLIP_FOLDER = "edited";

// One timestamped transcript cue (seconds are relative to the source video).
export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}
export interface Transcript {
  service: string; // e.g. 'openai-whisper' — honest attribution of who transcribed
  language: string | null;
  cues: TranscriptCue[];
  duration_seconds: number | null;
}

// One highlight the Anthropic model selected from the transcript. start/end are
// seconds into the source; hook + caption are the suggested short-form copy.
export interface Highlight {
  start: number;
  end: number;
  title: string; // short label for the clip (drives the draft's title)
  hook: string; // scroll-stopping opening line
  caption: string; // ready-to-post caption
  reason: string; // why this moment was picked (for the reviewer)
  score: number; // 0..1 confidence / strength
}

// Requester-chosen tunables, stored on vesper_clip_jobs.options. All optional;
// resolveOptions() fills sensible defaults.
export interface JobOptions {
  max_clips?: number;
  min_seconds?: number;
  max_seconds?: number;
  aspect?: "9:16" | "1:1" | "16:9";
}

export interface ResolvedJobOptions {
  max_clips: number;
  min_seconds: number;
  max_seconds: number;
  aspect: "9:16" | "1:1" | "16:9";
}

export const DEFAULT_JOB_OPTIONS: ResolvedJobOptions = {
  max_clips: 6,
  min_seconds: 12,
  max_seconds: 60,
  aspect: "9:16",
};

// Clamp user-supplied options into safe ranges. Bad/absent values fall back to
// the defaults — never trusted blindly (this can come from a form or an API).
export function resolveOptions(raw: JobOptions | null | undefined): ResolvedJobOptions {
  const o = raw ?? {};
  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const aspect =
    o.aspect === "1:1" || o.aspect === "16:9" || o.aspect === "9:16"
      ? o.aspect
      : DEFAULT_JOB_OPTIONS.aspect;
  const min_seconds = clamp(o.min_seconds, 5, 120, DEFAULT_JOB_OPTIONS.min_seconds);
  const max_seconds = Math.max(
    min_seconds + 1,
    clamp(o.max_seconds, 10, 180, DEFAULT_JOB_OPTIONS.max_seconds)
  );
  return {
    max_clips: clamp(o.max_clips, 1, 20, DEFAULT_JOB_OPTIONS.max_clips),
    min_seconds,
    max_seconds,
    aspect,
  };
}

// A vesper_clip_jobs row as the app reads it (loose — the table isn't in the
// generated Supabase types, same idiom as content_assets / media_assets).
export interface ClipJob {
  id: string;
  org_id: string;
  brand_id: string | null;
  source_asset_id: string | null;
  source_url: string | null;
  source_title: string | null;
  status: JobStatus;
  stage_detail: string | null;
  error: string | null;
  options: JobOptions | null;
  transcript: Transcript | null;
  segments: Highlight[] | null;
  clips_created: number;
  transcript_service: string | null;
  segment_model: string | null;
  requested_by: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Columns the app selects for a job row.
export const CLIP_JOB_COLS =
  "id, org_id, brand_id, source_asset_id, source_url, source_title, status, stage_detail, error, options, transcript, segments, clips_created, transcript_service, segment_model, requested_by, claimed_at, completed_at, created_at, updated_at";

// A short, human label for a status (badge text).
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  transcribing: "Transcribing",
  segmenting: "Finding highlights",
  clipping: "Cutting clips",
  drafting: "Creating drafts",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

// Badge tone per status (aligns with the app's <Badge> tones).
export function jobStatusTone(status: JobStatus): "teal" | "amber" | "red" | "muted" {
  if (status === "done") return "teal";
  if (status === "failed" || status === "canceled") return "red";
  if (ACTIVE_JOB_STATUSES.includes(status)) return "amber";
  return "muted";
}
