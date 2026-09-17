import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import { rollupMetricsSnapshots } from "@/lib/metrics/rollup";

export const runtime = "nodejs";
// Read env fresh per request (Vercel "Sensitive" runtime-only vars) and never
// cache — this is a mutating write, not a static read.
export const dynamic = "force-dynamic";
// A cross-department fold over every org; give it room but it is far lighter than
// the TikTok pull.
export const maxDuration = 120;

// POST/GET /api/automation/metrics-rollup — the daily DEPARTMENT-HEALTH rollup.
//
// Folds public.metric_entries + the live task / commerce signals into ONE
// metrics_snapshots row per (org_id, department_id, period), plus an org-level
// roll-up row. Idempotent upsert on the natural key, so the GitHub Actions schedule can call
// it every day and it refreshes rows in place instead of duplicating them.
//
// Two ways in — the SAME constant-time auth block as the TikTok daily sync
// (/api/integrations/tiktok/sync):
//   • A MACHINE trigger sends `Authorization: Bearer <secret>` and runs across
//     ALL orgs. The secret may be CRON_SECRET or AUTOMATION_API_KEY (the GitHub Actions
//     Schedule already holds the latter — it is the OS's reliable daily driver).
//     Both are server-side machine secrets, compared in constant time.
//   • A leadership "refresh" POSTs with the user's session — runs the caller's
//     org only.
// Anything else is rejected 401.
//
// WINDOW: the rollup uses the SAME convention as the TikTok sync — a rolling
// window ending YESTERDAY in Asia/Manila (default 30 days), so every table in the
// OS agrees on what "yesterday" means. `?days=N` overrides the span.
//
// NO VERCEL CRON: Vercel Hobby rejects sub-daily schedules (that already broke a
// deploy once). The external GitHub Actions schedule is the driver — see docs/INTEGRATION_PLAN.

function cronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}
function automationApiKey(): string | undefined {
  return process.env.AUTOMATION_API_KEY?.trim() || undefined;
}

// Constant-time check that the Authorization header is `Bearer <expected>`.
// Copied from /api/integrations/tiktok/sync — fails closed on a missing secret.
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

  // --- Window override (?days=N), same precedence idea as the TikTok sync. ---
  const daysParam = new URL(request.url).searchParams.get("days");
  const parsedDays = Number(daysParam);
  const windowDays =
    daysParam !== null && Number.isFinite(parsedDays) && parsedDays >= 1
      ? Math.floor(parsedDays)
      : 30;

  console.info("[rollup] start", {
    mode: isMachine ? "machine" : "manual",
    org: orgScope ?? "all",
    windowDays,
  });

  const result = await rollupMetricsSnapshots({ orgId: orgScope, windowDays });

  console.info("[rollup] done", {
    status: result.status,
    orgs: result.orgs,
    rowsUpserted: result.rowsUpserted,
    window: [result.window.startDate, result.window.endDate],
    warnings: result.warnings.length,
  });

  return NextResponse.json(result);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Support GET too, so a plain scheduled GET (or a manual curl) drives it.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
