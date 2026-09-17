// Vesper Studio — vesper_clip_jobs read/write helpers + clip-draft lookups.
// The table isn't in the generated Supabase types, so every access goes through
// the same loose-typed shim idiom used across the app (content_assets,
// media_assets, content_items). RLS still scopes every row for the user client;
// the worker uses the service-role client (which bypasses RLS) and scopes by id.

import {
  CLIP_JOB_COLS,
  SHORT_CLIP_KIND,
  type ClipJob,
  type JobStatus,
} from "@/lib/vesper/types";
import { ASSET_COLS, type ContentAsset } from "@/lib/content/assets";

// A minimal chainable+awaitable PostgREST shape covering the calls below. Each
// filter returns the same builder, which is itself awaitable.
type Query = {
  eq: (c: string, v: string) => Query;
  neq: (c: string, v: string) => Query;
  in: (c: string, v: string[]) => Query;
  order: (c: string, o: { ascending: boolean }) => Query;
  limit: (n: number) => Query;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
} & PromiseLike<{ data: unknown[] | null; error: unknown }>;

type ReadDb = { from: (t: string) => { select: (c: string) => Query } };
type WriteDb = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => {
      select: (c: string) => { single: () => Promise<{ data: { id: string } | null; error: unknown }> };
    };
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<{ error: unknown }> };
  };
};

// Anything with a PostgREST-ish `.from`. We only ever cast the real client to
// this — never construct it.
export type SupabaseLike = unknown;

// List an org's jobs (RLS-scoped for the user client). Optional brand filter.
export async function readJobs(
  supabase: SupabaseLike,
  opts: { brand?: string; limit?: number } = {}
): Promise<ClipJob[]> {
  let q = (supabase as ReadDb).from("vesper_clip_jobs").select(CLIP_JOB_COLS);
  if (opts.brand) q = q.eq("brand_id", opts.brand);
  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);
  if (error) {
    console.error("[vesper] readJobs failed", error);
    return [];
  }
  return (data ?? []) as unknown as ClipJob[];
}

// Read one job by id (RLS-scoped). null when missing.
export async function readJob(supabase: SupabaseLike, id: string): Promise<ClipJob | null> {
  const { data, error } = await (supabase as ReadDb)
    .from("vesper_clip_jobs")
    .select(CLIP_JOB_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("[vesper] readJob failed", error);
    return null;
  }
  return (data as ClipJob | null) ?? null;
}

// Create a job. org_id + requested_by are stamped from the session on insert so
// the RLS with_check passes; the caller has already validated the source. Returns
// the new job id, or null on failure.
export async function insertJob(
  supabase: SupabaseLike,
  input: {
    org_id: string;
    requested_by: string;
    brand_id: string | null;
    source_asset_id: string | null;
    source_url: string | null;
    source_title: string | null;
    options: Record<string, unknown>;
    // Optional human-readable "what's happened so far" seed. The Cloudinary
    // upload path sets this to 'uploaded' so the queue honestly reflects that the
    // replay is already stored; the older raw-asset/URL path omits it.
    stage_detail?: string | null;
  }
): Promise<string | null> {
  const { data, error } = await (supabase as WriteDb)
    .from("vesper_clip_jobs")
    .insert({
      org_id: input.org_id,
      requested_by: input.requested_by,
      brand_id: input.brand_id,
      source_asset_id: input.source_asset_id,
      source_url: input.source_url,
      source_title: input.source_title,
      options: input.options,
      status: "queued",
      ...(input.stage_detail !== undefined ? { stage_detail: input.stage_detail } : {}),
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    console.error("[vesper] insertJob failed", error);
    return null;
  }
  return data.id;
}

// Patch a job row by id. Returns true on success.
export async function updateJob(
  supabase: SupabaseLike,
  id: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { error } = await (supabase as WriteDb).from("vesper_clip_jobs").update(patch).eq("id", id);
  if (error) {
    console.error("[vesper] updateJob failed", id, error);
    return false;
  }
  return true;
}

// Read the clip DRAFTS (content_assets kind='short_clip') for a set of jobs, so
// the Vesper tab can show each job's produced clips. Grouped by job id via
// meta.vesper_job_id. RLS-scoped for the user client.
export async function readClipsForJobs(
  supabase: SupabaseLike,
  jobIds: string[]
): Promise<Map<string, ContentAsset[]>> {
  const byJob = new Map<string, ContentAsset[]>();
  if (jobIds.length === 0) return byJob;
  const { data, error } = await (supabase as ReadDb)
    .from("content_assets")
    .select(ASSET_COLS)
    .eq("kind", SHORT_CLIP_KIND)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) {
    console.error("[vesper] readClipsForJobs failed", error);
    return byJob;
  }
  const wanted = new Set(jobIds);
  for (const row of (data ?? []) as unknown as ContentAsset[]) {
    const jobId = (row.meta?.vesper_job_id as string | undefined) ?? null;
    if (!jobId || !wanted.has(jobId)) continue;
    const list = byJob.get(jobId) ?? [];
    list.push(row);
    byJob.set(jobId, list);
  }
  return byJob;
}

// True when a job is in a state where re-running in-app segmentation makes sense:
// it has a transcript but no committed segments yet (or it failed). Used to gate
// the "Find highlights" button in the UI.
export function canRunSegmentation(job: ClipJob): boolean {
  const hasTranscript = Boolean(job.transcript && job.transcript.cues?.length);
  const terminalOk: JobStatus[] = ["failed"];
  return hasTranscript && (job.status === "segmenting" || terminalOk.includes(job.status));
}
