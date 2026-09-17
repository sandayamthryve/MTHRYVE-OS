import { NextRequest, NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { cronSecret, isTikTokConfigured, tiktokSyncWindowDays } from "@/lib/tiktok/config";
import { resolveWindow } from "@/lib/tiktok/sync";
import { reconcileTikTok } from "@/lib/tiktok/reconcile";

export const runtime = "nodejs";
// Read env fresh per request and never cache — this mutates brand_platform_metrics.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST/GET /api/integrations/tiktok/reconcile — lift landed TikTok Shop data
// (tiktok_shop_performance + tiktok_settlements) into brand_platform_metrics.
//
// NOTE (PR 3): brand_platform_metrics is DEPRECATED for reads — dashboards now read
// the live tiktok_shop_performance directly (lib/metrics/gmv → fetchCommerceRows),
// not the reconciled bpm rows. This route is kept because the write still maintains
// the per-brand audit trail in bpm and asserts the fold is exact; it no longer feeds
// what the dashboards display.
//
// The daily sync already calls reconcileTikTok() as its final step; this route
// exists so the reconcile can be re-run on its own (e.g. a leadership "reconcile
// now", or a backfill with ?days=N) without re-pulling from TikTok.
//
// Auth mirrors the sync route exactly:
//   • Vercel Cron / server: `Authorization: Bearer ${CRON_SECRET}` → all orgs.
//   • Leadership session → the caller's org only.
// ?days=N (default TIKTOK_SYNC_WINDOW_DAYS, 30) sets the window = [today-N ..
// yesterday] in Asia/Manila, identical to the sync's rolling default so the two
// stay in lockstep. A larger ?days=90 re-lifts a backfill's history.

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

  if (!isTikTokConfigured()) {
    return NextResponse.json({ error: "tiktok_not_configured" }, { status: 503 });
  }

  const daysRaw = new URL(request.url).searchParams.get("days");
  const parsedDays = Number(daysRaw);
  const daysParam =
    daysRaw !== null && Number.isFinite(parsedDays) && parsedDays >= 1
      ? Math.floor(parsedDays)
      : tiktokSyncWindowDays();
  const win = resolveWindow(daysParam);
  const window = { startDate: win.startDate, endDate: win.endDate };

  console.info("[tiktok] reconcile start", {
    mode: isCron ? "cron" : "manual",
    org: orgScope ?? "all",
    window: [window.startDate, window.endDate],
  });

  const result = await reconcileTikTok({ orgId: orgScope, window });
  console.info("[tiktok] reconcile done", {
    orgs: result.orgs,
    rows: result.rowsUpserted,
    superseded: result.superseded,
    reconciledOrgs: result.reconciledOrgs,
  });

  // A GMV mismatch is a data-integrity failure worth a non-200 so a caller (or
  // an uptime check) notices; the body still carries the full per-org detail.
  const httpStatus = result.status === "success" ? 200 : 207;
  return NextResponse.json(result, { status: httpStatus });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Vercel Cron issues a GET; support both so the same route serves cron + manual.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
