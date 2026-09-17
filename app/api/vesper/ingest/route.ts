import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { insertJob } from "@/lib/vesper/jobs";
import { resolveOptions, type JobOptions } from "@/lib/vesper/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IngestSchema = z
  .object({
    source_asset_id: z.string().max(200).optional(),
    source_url: z.string().max(2_000).optional(),
    brand_id: z.string().max(200).nullish(),
    options: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

// POST /api/vesper/ingest — STAGE 1 (Ingest). Register a source long-form video
// as an auto-clipping job. Two source modes:
//   { source_asset_id }  → an existing raw media_assets row already in the
//                          creative-media bucket (folder 'raw'). Preferred.
//   { source_url }       → an external URL the WORKER will fetch + store into
//                          creative-media/raw before processing.
// Optional: { brand_id, options: { max_clips, min_seconds, max_seconds, aspect } }.
//
// This only ENQUEUES — no video is touched here (ffmpeg/transcription can't run
// in this serverless runtime). The out-of-runtime worker picks the job up. Any
// authed org member may enqueue (RLS scopes the row to their org).
export async function POST(request: NextRequest) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    const parsed = IngestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
    }
    body = parsed.data as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const sourceAssetId = typeof body.source_asset_id === "string" ? body.source_asset_id.trim() : "";
  const sourceUrlRaw = typeof body.source_url === "string" ? body.source_url.trim() : "";
  const brandId = typeof body.brand_id === "string" && body.brand_id.trim() ? body.brand_id.trim() : null;
  const options = resolveOptions((body.options ?? null) as JobOptions | null);

  // Validate the source: exactly one mode, and a URL must be http(s).
  let sourceUrl: string | null = null;
  if (sourceUrlRaw) {
    try {
      const u = new URL(sourceUrlRaw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("proto");
      sourceUrl = u.toString();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid_source_url" }, { status: 400 });
    }
  }
  if (!sourceAssetId && !sourceUrl) {
    return NextResponse.json(
      { ok: false, error: "missing_source", detail: "Provide source_asset_id or source_url." },
      { status: 400 }
    );
  }

  // If an asset id was given, confirm it exists in the caller's org and is a raw
  // video (RLS scopes the read). This also gives us a title for the job.
  let sourceTitle: string | null = null;
  let resolvedAssetId: string | null = null;
  if (sourceAssetId) {
    const { data } = await (supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (c: string, v: string) => {
            maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
          };
        };
      };
    })
      .from("media_assets")
      .select("id, title, folder, mime_type")
      .eq("id", sourceAssetId)
      .maybeSingle();
    const asset = data as
      | { id: string; title: string | null; folder: string; mime_type: string | null }
      | null;
    if (!asset) {
      return NextResponse.json({ ok: false, error: "source_not_found" }, { status: 404 });
    }
    resolvedAssetId = asset.id;
    sourceTitle = asset.title;
  }

  const jobId = await insertJob(supabase, {
    org_id: profile.org_id,
    requested_by: profile.id,
    brand_id: brandId,
    source_asset_id: resolvedAssetId,
    source_url: sourceUrl,
    source_title: sourceTitle,
    options: options as unknown as Record<string, unknown>,
  });

  if (!jobId) {
    return NextResponse.json({ ok: false, error: "enqueue_failed" }, { status: 500 });
  }

  console.log("[vesper] enqueued job", jobId, "org", profile.org_id, "by", profile.id);
  return NextResponse.json({ ok: true, job_id: jobId, status: "queued" });
}
