import { NextRequest, NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { readJob, readClipsForJobs } from "@/lib/vesper/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/vesper/jobs/[id] — job status + a light view of its produced clip
// drafts. Used by the Vesper Studio UI to poll a job while the worker runs it.
// RLS scopes the read to the caller's org.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  await requireProfile();
  const supabase = createServerSupabaseClient();

  const job = await readJob(supabase, params.id);
  if (!job) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const clipsByJob = await readClipsForJobs(supabase, [job.id]);
  const clips = (clipsByJob.get(job.id) ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    duration_seconds: c.duration_seconds,
    content_item_id: c.content_item_id,
  }));

  return NextResponse.json({
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      stage_detail: job.stage_detail,
      error: job.error,
      clips_created: job.clips_created,
      transcript_service: job.transcript_service,
      segment_model: job.segment_model,
      segments: job.segments,
      created_at: job.created_at,
      updated_at: job.updated_at,
    },
    clips,
  });
}
