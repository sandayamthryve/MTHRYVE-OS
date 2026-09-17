import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  automationBearerOk,
  claimOldestJob,
  patchJob,
  type ServiceDb,
} from "@/lib/vesper/automation";
import { selectHighlights } from "@/lib/vesper/segment";
import type { JobOptions } from "@/lib/vesper/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The model that picks the highlight windows. Matches the worker's default
// (VESPER_SEGMENT_MODEL). Sonnet is the sweet spot for this JSON selection task;
// override per-deploy without touching code.
const SEGMENT_MODEL = process.env.VESPER_SEGMENT_MODEL?.trim() || "claude-sonnet-5";
// The brief caps clips at 15–60s and biases to SELLABLE standalone moments, so
// when a job didn't set its own floor we default to a 15s minimum here.
const DEFAULT_MIN_SECONDS = 15;

// POST /api/vesper/segment — STAGE 2 of the Phase-2 pipeline (GitHub Actions-driven).
//
// Claims the OLDEST status='segmenting' job with a GUARDED update (…where
// status='segmenting') so two pollers can't double-run it, flips it to
// 'drafting' (Phase 2's terminal — no rendering here), then asks the Anthropic
// model to pick 3–5 sellable highlight windows from the stored transcript. On
// success the segments + segment_model are stored; any error marks the job
// 'failed' with the reason. This ends the Phase-2 pipeline at 'drafting'.
//
// AUTH: the shared automation bearer (AUTOMATION_API_KEY). No user session; the
// service-role client processes the queue across orgs.
export async function POST(req: NextRequest) {
  if (!automationBearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const db = createServiceRoleClient() as unknown as ServiceDb;

  // Guarded claim: segmenting → drafting. Flipping the status IS the double-run
  // guard — a second poller finds no 'segmenting' row and no-ops. We do the LLM
  // work while already in 'drafting'; if it errors we flip to 'failed' so the
  // job never hangs in 'drafting' without segments.
  const job = await claimOldestJob(db, "segmenting", "drafting", {
    stage_detail: "Selecting sellable highlights (Anthropic)",
    error: null,
  });
  if (!job) {
    return NextResponse.json({ ok: true, claimed: false, message: "no segmenting jobs" });
  }

  const transcript = job.transcript;
  if (!transcript || !Array.isArray(transcript.cues) || transcript.cues.length === 0) {
    await patchJob(db, job.id, {
      status: "failed",
      error: "no_transcript — segment stage claimed a job without a transcript.",
      stage_detail: null,
    });
    return NextResponse.json({ ok: false, job_id: job.id, error: "no_transcript" }, { status: 409 });
  }

  const options: JobOptions = {
    ...(job.options ?? {}),
    min_seconds: job.options?.min_seconds ?? DEFAULT_MIN_SECONDS,
  };

  let result;
  try {
    result = await selectHighlights(transcript, options, { apiKey, model: SEGMENT_MODEL });
  } catch (e) {
    // selectHighlights is defensive and shouldn't throw, but never let an
    // unexpected throw strand the job in 'drafting'.
    console.error("[vesper/segment] selectHighlights threw", job.id, e);
    await patchJob(db, job.id, { status: "failed", error: "Segment selection crashed.", stage_detail: null });
    return NextResponse.json({ ok: false, job_id: job.id, error: "segment_crash" }, { status: 500 });
  }

  if (result.error && result.highlights.length === 0) {
    await patchJob(db, job.id, {
      status: "failed",
      error: `Segment selection failed: ${result.error}`,
      stage_detail: null,
    });
    console.error("[vesper/segment] failed", job.id, result.error);
    return NextResponse.json({ ok: false, job_id: job.id, error: result.error }, { status: 502 });
  }

  // Cost breadcrumb: log the model's token usage so per-job cost is visible
  // BEFORE scaling (the brief's cost guardrail). Non-destructive merge into
  // options alongside the transcription minutes stamped by the transcribe route.
  const mergedOptions = {
    ...(job.options ?? {}),
    _cost: {
      ...((job.options as Record<string, unknown> | null)?._cost as Record<string, unknown> | undefined),
      segment_input_tokens: result.usage?.input_tokens ?? null,
      segment_output_tokens: result.usage?.output_tokens ?? null,
    },
  };

  const ok = await patchJob(db, job.id, {
    segments: result.highlights,
    segment_model: result.model,
    options: mergedOptions,
    // Stay in 'drafting' — Phase 2 ends here; the (future) render stage picks up
    // 'drafting' jobs. Empty highlights is a valid, honest outcome (not a fail).
    stage_detail:
      result.highlights.length > 0
        ? `${result.highlights.length} sellable highlight(s) selected`
        : "No clip-worthy highlights found",
    error: null,
  });
  if (!ok) {
    return NextResponse.json({ ok: false, job_id: job.id, error: "persist_failed" }, { status: 500 });
  }

  console.log(
    "[vesper/segment] ok",
    job.id,
    "highlights",
    result.highlights.length,
    "model",
    result.model,
    "tokens",
    result.usage
  );
  return NextResponse.json({
    ok: true,
    claimed: true,
    job_id: job.id,
    status: "drafting",
    highlights: result.highlights.length,
    model: result.model,
    usage: result.usage,
  });
}
