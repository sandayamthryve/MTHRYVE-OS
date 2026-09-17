import { NextRequest, NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { cronSecret } from "@/lib/tiktok/config";
import { syncMetrics } from "@/lib/metrics/sync";

export const runtime = "nodejs";
// Reads env fresh per request and never caches — this mutates metric_entries.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/metrics/sync — the API Validation Overlay sync (Phase 2, Part A).
//
// Fills metric_entries.api_value (ONLY) for the requested period from each
// auto / auto_possible catalog metric's mapped source table. The Phase-1 trigger
// then derives variance_pct + validation_status; a > 15% gap opens a pending
// action_request. NO historical backfill — exactly the one period requested.
//
// Auth mirrors the TikTok sync/reconcile routes:
//   • Vercel Cron / server: `Authorization: Bearer ${CRON_SECRET}` → all orgs.
//   • Leadership session (ceo / coo / department_head) → the caller's org only.
// No secret is ever hardcoded and none is returned to the client; the service-
// role key lives only inside lib/metrics/sync.ts (server).
//
// Period is required and comes from JSON body { period_start, period_end } or
// query params ?period_start=&period_end= (YYYY-MM-DD, inclusive).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function readPeriod(
  request: NextRequest
): Promise<{ start: string; end: string } | { error: string }> {
  const url = new URL(request.url);
  let start = url.searchParams.get("period_start") ?? "";
  let end = url.searchParams.get("period_end") ?? "";

  if ((!start || !end) && request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = (await request.json()) as { period_start?: unknown; period_end?: unknown };
      start = start || String(body.period_start ?? "");
      end = end || String(body.period_end ?? "");
    } catch {
      // no/invalid JSON body — fall through to validation
    }
  }

  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return { error: "period_start and period_end (YYYY-MM-DD) are required" };
  }
  if (end < start) return { error: "period_end must be on or after period_start" };
  return { start, end };
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const secret = cronSecret();
  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  const isCron = Boolean(secret) && authHeader === `Bearer ${secret}`;

  let orgScope: string | undefined;
  if (!isCron) {
    const profile = await getSessionProfile();
    const leadership =
      profile?.role === "ceo" || profile?.role === "coo" || profile?.role === "department_head";
    if (!profile || !leadership) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    orgScope = profile.org_id;
  }

  const period = await readPeriod(request);
  if ("error" in period) {
    return NextResponse.json({ error: period.error }, { status: 400 });
  }

  const result = await syncMetrics({
    orgId: orgScope,
    window: { startDate: period.start, endDate: period.end },
  });

  const applied = result.results.reduce((n, r) => n + r.applied.length, 0);
  const escalated = result.results.reduce((n, r) => n + r.escalated.length, 0);
  console.info("[metrics] sync done", {
    mode: isCron ? "cron" : "manual",
    org: orgScope ?? "all",
    period: [period.start, period.end],
    orgs: result.orgs,
    applied,
    escalated,
  });

  return NextResponse.json(result, { status: 200 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Vercel Cron issues a GET — support both so one route serves cron + manual.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
