import { NextRequest, NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readJob, updateJob } from "@/lib/vesper/jobs";
import { selectHighlights } from "@/lib/vesper/segment";
import { defaultTierFor, TIER_MODEL } from "@/lib/ai/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/vesper/jobs/[id]/segment — STAGE 2b (Segment selection), run IN-APP.
// Given a job that already carries a timestamped transcript (produced by the
// worker's transcription step), ask the ANTHROPIC model to select the highlight
// windows + suggested hook/caption, store them on the job, and advance it to
// 'clipping' so the worker cuts them. This is the same logic the worker can run
// offline (lib/vesper/segment.ts); exposing it here makes the Anthropic step
// testable in the app runtime without ffmpeg.
//
// The model is chosen by the caller's role tier (same governance as the Creative
// Studio brief generator). ANTHROPIC_API_KEY is read at call time, server-side.
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const job = await readJob(supabase, params.id);
  if (!job) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const transcript = job.transcript;
  if (!transcript || !Array.isArray(transcript.cues) || transcript.cues.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no_transcript", detail: "The job has no transcript yet — the worker transcribes first." },
      { status: 409 }
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const model = TIER_MODEL[defaultTierFor(profile.role)];
  await updateJob(supabase, job.id, { status: "segmenting", stage_detail: "Selecting highlights (Anthropic)" });

  const result = await selectHighlights(transcript, job.options, { apiKey, model });
  if (result.error && result.highlights.length === 0) {
    // Persist the detailed reason on the job + log it; return a generic message.
    await updateJob(supabase, job.id, {
      status: "failed",
      error: `Segment selection failed: ${result.error}`,
    });
    console.error("[vesper/segment] selection failed", job.id, result.error);
    return NextResponse.json({ ok: false, error: "Segment selection failed." }, { status: 502 });
  }

  await updateJob(supabase, job.id, {
    segments: result.highlights,
    segment_model: result.model,
    // Hand back to the worker to cut the clips; if none were found, we're done.
    status: result.highlights.length > 0 ? "clipping" : "done",
    stage_detail:
      result.highlights.length > 0
        ? `${result.highlights.length} highlight(s) selected — cutting`
        : "No clip-worthy highlights found",
    ...(result.highlights.length === 0 ? { completed_at: new Date().toISOString() } : {}),
  });

  console.log("[vesper] segmented job", job.id, "highlights", result.highlights.length, "model", result.model);
  return NextResponse.json({
    ok: true,
    job_id: job.id,
    model: result.model,
    highlights: result.highlights,
    next: result.highlights.length > 0 ? "clipping" : "done",
  });
}
