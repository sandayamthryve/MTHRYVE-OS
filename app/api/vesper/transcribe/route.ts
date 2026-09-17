import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  automationBearerOk,
  claimOldestJob,
  patchJob,
  type ServiceDb,
} from "@/lib/vesper/automation";
import { transcribeFromUrl } from "@/lib/vesper/transcribe";

export const runtime = "nodejs";
// Read the automation secret + provider keys fresh per request (Vercel
// "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";
// Whisper on a ~45-min replay can take a while; give it room but stay under the
// serverless ceiling. GitHub Actions calls this on a schedule, one job per call.
export const maxDuration = 300;

// POST /api/vesper/transcribe — STAGE 1 of the Phase-2 pipeline (GitHub Actions-driven).
//
// Claims the OLDEST status='queued' job with a GUARDED update (…where
// status='queued') so two pollers can't grab the same one, flips it to
// 'transcribing' (+claimed_at), then transcribes its Cloudinary replay with
// OpenAI Whisper (verbose_json → timestamped cues; Taglish-pinned). On success
// the transcript + transcript_service are stored and the job advances to
// 'segmenting'; any error marks it 'failed' with the reason (a failed job always
// carries an error — it never hangs).
//
// AUTH: the shared automation bearer (AUTOMATION_API_KEY) — the same gate GitHub Actions
// uses for the other /api/automation routes. No user session; the service-role
// client processes the queue across orgs (like the out-of-runtime worker).
export async function POST(req: NextRequest) {
  if (!automationBearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const db = createServiceRoleClient() as unknown as ServiceDb;

  // Guarded claim: queued → transcribing (idempotent; loser of a race gets null).
  const job = await claimOldestJob(db, "queued", "transcribing", {
    claimed_at: new Date().toISOString(),
    stage_detail: "Transcribing replay (Whisper)",
    error: null,
  });
  if (!job) {
    return NextResponse.json({ ok: true, claimed: false, message: "no queued jobs" });
  }

  // This in-runtime path transcribes a Cloudinary-hosted replay (audio delivered
  // by Cloudinary, no ffmpeg). A job without a source_url can't be handled here —
  // fail it honestly and point at the worker rather than hanging.
  if (!job.source_url) {
    await patchJob(db, job.id, {
      status: "failed",
      error: "no_source_url — runtime transcription needs a Cloudinary replay URL; use the worker for raw-asset sources.",
    });
    return NextResponse.json({ ok: false, job_id: job.id, error: "no_source_url" }, { status: 422 });
  }

  const result = await transcribeFromUrl(job.source_url);

  if (result.error || !result.transcript) {
    await patchJob(db, job.id, {
      status: "failed",
      error: `Transcription failed: ${result.error ?? "unknown"}`,
      stage_detail: null,
    });
    console.error("[vesper/transcribe] failed", job.id, result.error);
    return NextResponse.json({ ok: false, job_id: job.id, error: result.error }, { status: 502 });
  }

  // Cost breadcrumb: log transcript minutes + audio bytes so we can see per-job
  // cost BEFORE scaling (the brief's cost guardrail). Kept on stage_detail
  // (human-readable) and mirrored into options (machine-readable, non-destructive
  // merge of the requester's tunables).
  const minutes = result.minutes ?? 0;
  const stageDetail = `Transcribed ${result.transcript.cues.length} cues · ~${minutes} min`;
  const mergedOptions = {
    ...(job.options ?? {}),
    _cost: {
      ...((job.options as Record<string, unknown> | null)?._cost as Record<string, unknown> | undefined),
      transcribe_minutes: result.minutes,
      transcribe_bytes: result.bytes,
    },
  };

  const ok = await patchJob(db, job.id, {
    transcript: result.transcript,
    transcript_service: result.service,
    options: mergedOptions,
    status: "segmenting",
    stage_detail: stageDetail,
    error: null,
  });
  if (!ok) {
    return NextResponse.json({ ok: false, job_id: job.id, error: "persist_failed" }, { status: 500 });
  }

  console.log(
    "[vesper/transcribe] ok",
    job.id,
    "cues",
    result.transcript.cues.length,
    "minutes",
    result.minutes,
    "bytes",
    result.bytes
  );
  return NextResponse.json({
    ok: true,
    claimed: true,
    job_id: job.id,
    status: "segmenting",
    cues: result.transcript.cues.length,
    minutes: result.minutes,
    service: result.service,
  });
}
