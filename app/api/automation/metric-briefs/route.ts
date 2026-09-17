import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import { refreshMetricBriefs } from "@/lib/briefings/metric-briefs";

export const runtime = "nodejs";
// Read env fresh per request (Vercel "Sensitive" runtime-only vars) and never
// cache — this regenerates + writes the metric-brief cache, it is not a static read.
export const dynamic = "force-dynamic";
// One cheap Haiku call per org over ≤6 short metric contexts; generous ceiling.
export const maxDuration = 120;

// POST/GET /api/automation/metric-briefs — the BACKGROUND refresh of the Mission
// Control per-metric AI blurbs (WHY / POTENTIAL IMPACT).
//
// This is the ONLY place the model is called for those blurbs. The dashboard
// render reads the last cached value from public.metric_brief_cache and NEVER
// awaits the model (see lib/briefings/metric-briefs.ts). Driven daily by the
// GitHub Actions scheduler (.github/workflows/automation-schedule.yml), staggered
// just after the metrics-rollup so it reasons over freshly-landed figures.
//
// Auth mirrors /api/automation/metrics-rollup exactly — a constant-time machine
// bearer (CRON_SECRET or AUTOMATION_API_KEY) runs ALL orgs; a leadership session
// runs only the caller's org. Anything else is 401.
//
// NO VERCEL CRON: Vercel Hobby rejects sub-daily schedules, so the schedule lives
// in GitHub Actions, exactly like every other automation route.

function cronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}
function automationApiKey(): string | undefined {
  return process.env.AUTOMATION_API_KEY?.trim() || undefined;
}

// Constant-time check that the Authorization header is `Bearer <expected>`.
// Copied from /api/automation/metrics-rollup — fails closed on a missing secret.
function bearerMatches(authHeader: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const provided = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  // --- Auth: leadership session OR a machine bearer (cron OR GitHub Actions automation). ---
  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  const isMachine =
    bearerMatches(authHeader, cronSecret()) || bearerMatches(authHeader, automationApiKey());

  let orgScope: string | undefined;
  if (!isMachine) {
    const profile = await getSessionProfile();
    const leadership =
      profile?.role === "ceo" || profile?.role === "coo" || profile?.role === "department_head";
    if (!profile || !leadership) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // A manual refresh only touches the caller's own org.
    orgScope = profile.org_id;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  console.info("[metric-briefs] start", {
    mode: isMachine ? "machine" : "manual",
    org: orgScope ?? "all",
  });

  const result = await refreshMetricBriefs({ orgId: orgScope });

  console.info("[metric-briefs] done", result);

  // Doctrine #10 (no silent failure): a run that wrote NOTHING while at least one
  // org failed did no work — it must turn the scheduler RED, not report a green
  // "ok" (the products-sync silent-failure mode). Partial success (written > 0)
  // still succeeds — some orgs refreshed, and the failed ones keep their last
  // cached blurbs. Zero orgs / zero failures is a legitimate 200 no-op.
  if (result.failed > 0 && result.written === 0) {
    console.error("[metric-briefs] all orgs failed, nothing written — failing the run", result);
    return NextResponse.json({ status: "failed", ...result }, { status: 502 });
  }

  return NextResponse.json({ status: "ok", ...result });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Support GET too, so a plain scheduled GET (or a manual curl) drives it.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
