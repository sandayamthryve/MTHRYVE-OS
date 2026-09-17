import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseJsonBody } from "@/lib/security/api";
import { hasVesperStudioAccess } from "@/lib/vesper/access";
import { insertJob } from "@/lib/vesper/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/vesper/jobs — STAGE 1 (Ingest), Cloudinary path. Called by the Vesper
// upload UI AFTER the browser has uploaded the replay directly to Cloudinary. It
// records a vesper_clip_jobs row pointing at the Cloudinary secure_url; the
// out-of-runtime worker (worker/vesper-clipper.mjs) fetches that URL and does the
// heavy media work. No video is touched in this runtime.
//
// Gate: Creative department members + department_head + ceo/coo (same as the
// signature route). requested_by + org_id are stamped from the session — never
// trusted from the client — so the row is always scoped to the caller's org.
const JobSchema = z.object({
  // Cloudinary results from the direct upload.
  source_url: z.string().url().max(2_000),
  public_id: z.string().max(400),
  title: z.string().max(300).optional(),
  duration: z.number().finite().nonnegative().optional(),
  bytes: z.number().finite().nonnegative().optional(),
  format: z.string().max(40).optional(),
  // Optional brand association (an active brand id from the picker).
  brand_id: z.string().uuid().nullish(),
});

// A loosely-typed read client for the brand ownership check (brands is in the
// generated types, but every Vesper helper casts through a shim; this keeps the
// route self-contained).
type BrandReadDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export async function POST(request: Request) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  if (!(await hasVesperStudioAccess(supabase, profile))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const parsed = await parseJsonBody(request, JobSchema, "vesper-jobs");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // secure_url must be an https Cloudinary URL — reject anything else so a job
  // can't be pointed at an arbitrary origin.
  let sourceUrl: string;
  try {
    const u = new URL(body.source_url);
    if (u.protocol !== "https:") throw new Error("proto");
    sourceUrl = u.toString();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_source_url" }, { status: 400 });
  }

  // If a brand was chosen, confirm it exists in the caller's org (RLS scopes the
  // read). A stale / cross-org id is dropped to null rather than failing the job.
  let brandId: string | null = null;
  if (body.brand_id) {
    const { data } = await (supabase as unknown as BrandReadDb)
      .from("brands")
      .select("id")
      .eq("id", body.brand_id)
      .maybeSingle();
    brandId = (data as { id?: string } | null)?.id ?? null;
  }

  const title = (body.title ?? "").trim() || null;

  // Upload metadata lives on options (jsonb) — the worker reads public_id to
  // manage the Cloudinary asset; duration/bytes/format are honest provenance.
  const options: Record<string, unknown> = {
    public_id: body.public_id,
    duration: body.duration ?? null,
    bytes: body.bytes ?? null,
    format: body.format ?? null,
  };

  const jobId = await insertJob(supabase, {
    org_id: profile.org_id,
    requested_by: profile.id,
    brand_id: brandId,
    source_asset_id: null,
    source_url: sourceUrl,
    source_title: title,
    options,
    // Honest state: the replay is already stored in Cloudinary; the pipeline
    // hasn't started. Status stays 'queued' until the Phase 2 worker exists.
    stage_detail: "uploaded",
  });

  if (!jobId) {
    return NextResponse.json({ ok: false, error: "enqueue_failed" }, { status: 500 });
  }

  console.log("[vesper] created clip job", jobId, "org", profile.org_id, "by", profile.id);
  return NextResponse.json({ ok: true, job_id: jobId, status: "queued" });
}
