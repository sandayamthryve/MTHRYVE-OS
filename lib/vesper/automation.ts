// Vesper Studio — shared plumbing for the two AUTOMATION-BEARER pipeline routes
// (POST /api/vesper/transcribe and POST /api/vesper/segment). GitHub Actions polls these on
// a schedule; each call advances ONE job by ONE stage. Both use the service-role
// client (no user session — the queue is processed across orgs, exactly like the
// out-of-runtime worker), and both must be safe to run concurrently, so the
// claim is a GUARDED compare-and-swap: only the update whose `status` predicate
// still matches wins, so two pollers can never grab the same job.

import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { CLIP_JOB_COLS, type ClipJob, type JobStatus } from "@/lib/vesper/types";

// A minimal loose shape for the service-role client against vesper_clip_jobs.
// The table isn't in the generated Supabase types, so — like daily-tap and the
// jobs helpers — we cast the real client to this rather than fight the types.
export type ServiceDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => {
        order: (c: string, o: { ascending: boolean }) => {
          limit: (n: number) => PromiseLike<{ data: { id: string }[] | null; error: unknown }>;
        };
      };
    };
    update: (v: Record<string, unknown>) => {
      eq: (c: string, v: string) => {
        eq: (c: string, v: string) => {
          select: (c: string) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
        };
      } & PromiseLike<{ error: unknown }>;
    };
  };
};

// Constant-time bearer check against AUTOMATION_API_KEY — the SAME shared secret
// (GitHub Actions "Mthryve OS Automation Key") that guards the other /api/automation routes.
// Fails CLOSED when the secret isn't configured, so a missing env var can never
// open the gate. Mirrors app/api/automation/daily-tap exactly.
export function automationBearerOk(req: NextRequest): boolean {
  const expected = process.env.AUTOMATION_API_KEY?.trim();
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = match?.[1]?.trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Guarded claim: atomically move the OLDEST job in `from` status to `to`,
// applying `patch` in the same update. Returns the claimed row, or null when
// there's nothing to claim OR another poller won the race (the guarded update
// then matches zero rows). The `.eq('status', from)` on the UPDATE is the whole
// guard — the candidate SELECT is only to pick the oldest id; the CAS is what
// makes it safe.
export async function claimOldestJob(
  db: ServiceDb,
  from: JobStatus,
  to: JobStatus,
  patch: Record<string, unknown> = {}
): Promise<ClipJob | null> {
  const { data: candidates, error: findErr } = await db
    .from("vesper_clip_jobs")
    .select("id")
    .eq("status", from)
    .order("created_at", { ascending: true })
    .limit(1);
  if (findErr) {
    console.error("[vesper/automation] candidate lookup failed", findErr);
    return null;
  }
  const candidate = candidates?.[0];
  if (!candidate) return null;

  const { data, error } = await db
    .from("vesper_clip_jobs")
    .update({ status: to, ...patch })
    .eq("id", candidate.id)
    .eq("status", from) // guard: only if it's STILL in `from` (CAS)
    .select(CLIP_JOB_COLS);
  if (error) {
    console.error("[vesper/automation] claim update failed", candidate.id, error);
    return null;
  }
  // Empty → another poller flipped the status between our SELECT and UPDATE.
  return ((data?.[0] as ClipJob | undefined) ?? null) || null;
}

// Patch a job by id with the service-role client. Returns true on success. Used
// for the terminal writes (store transcript/segments, or mark 'failed'+error).
export async function patchJob(
  db: ServiceDb,
  id: string,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { error } = await db.from("vesper_clip_jobs").update(patch).eq("id", id);
  if (error) {
    console.error("[vesper/automation] patchJob failed", id, error);
    return false;
  }
  return true;
}
