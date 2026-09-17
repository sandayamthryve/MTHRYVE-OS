import { NextRequest, NextResponse } from "next/server";
import { getSessionProfile, isLeadership } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import { rateLimit } from "@/lib/security/rate-limit";
import { getJob, type ManualRunResult } from "@/lib/automation/manual-jobs";

export const runtime = "nodejs";
// Read env fresh per request and never cache — these are mutating job runs.
export const dynamic = "force-dynamic";
// The products sync in particular is a multi-shop, per-product pull; give it the
// same room the bearer route has.
export const maxDuration = 300;

// POST /api/admin/automation/run — the MANUAL OVERRIDE for the scheduled jobs.
//
// This is NOT the bearer path. GitHub Actions keeps driving the /api/automation/* routes on
// its Schedule with the AUTOMATION_API_KEY, untouched. This route lets a HUMAN
// fire the SAME work function, authenticated by their EXISTING user session — so
// a leader can run a job on demand without ever needing the (unrevealable) key.
//
// GUARANTEES:
//   • Leadership-only (ceo/coo), enforced SERVER-SIDE with the same isLeadership
//     helper the Review Gate's leadership-class floor uses. A non-leadership
//     session — even a direct POST bypassing the hidden UI — gets 403.
//   • The AUTOMATION_API_KEY is never read here and never sent to the browser.
//   • Rate-limited to one run per job per org per 60s, so a double-click can't
//     fire two concurrent syncs.
//   • Every run is written to action_audit: who, which job, when, what result.
//
// Body: { "job": "products-sync" | "metrics-rollup" }.

interface RunBody {
  job?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- AuthN: a real signed-in session (never a machine bearer). ---
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // --- AuthZ: leadership only. SAME helper as the Review Gate class floor. This
  // is the real enforcement — the panel is also hidden for non-leadership, but a
  // direct POST is rejected here regardless of the UI. ---
  if (!isLeadership(profile.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // --- Which job. ---
  let body: RunBody;
  try {
    body = (await request.json()) as RunBody;
  } catch {
    body = {};
  }
  const jobKey = typeof body.job === "string" ? body.job : "";
  const job = getJob(jobKey);
  if (!job) {
    return NextResponse.json({ error: "unknown_job" }, { status: 400 });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  // --- Safety: one manual run per job per org per 60s. A double-click (or two
  // leaders clicking at once) cannot start two concurrent syncs. The window key
  // is per-org so one org's run never throttles another's. Fail-open by contract
  // (a limiter outage never blocks a legitimate run). ---
  const rl = await rateLimit(`admin_automation:${job.key}:${profile.org_id}`, {
    limit: 1,
    windowMs: 60_000,
  });
  if (!rl.success) {
    const retryAfter = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
    return NextResponse.json(
      { error: "rate_limited", retryAfterSeconds: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  // --- Run the SAME work the bearer route calls. Never throws past here: a job
  // failure is reported as a result, and still audited. ---
  let result: ManualRunResult;
  try {
    result = await job.run(profile.org_id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result = { ok: false, errors: [message], summary: `Run threw: ${message}` };
    console.error("[admin/automation] job threw", { job: job.key, message });
  }

  // --- Audit: who / which job / when / what result. Written with the
  // service-role client so the trail can never be blocked or forged from a
  // session; org-stamped so it shows in the org's /audit feed. Best-effort —
  // recording the trail must never break the run it describes. ---
  await writeActionAudit(createServiceRoleClient() as unknown as { from: (t: string) => any }, {
    org_id: profile.org_id,
    action_request_id: null,
    event: "automation_run",
    actor_id: profile.id,
    actor_role: profile.role,
    detail: {
      job: job.key,
      job_name: job.name,
      source: "manual",
      ok: result.ok,
      created: result.created ?? null,
      updated: result.updated ?? null,
      skipped: result.skipped ?? null,
      error_count: result.errors.length,
      errors: result.errors.slice(0, 10),
      summary: result.summary,
    },
  });

  const ranAt = new Date().toISOString();
  console.info("[admin/automation] manual run", {
    job: job.key,
    actor: profile.id,
    role: profile.role,
    ok: result.ok,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return NextResponse.json({ ...result, job: job.key, ranAt });
}
