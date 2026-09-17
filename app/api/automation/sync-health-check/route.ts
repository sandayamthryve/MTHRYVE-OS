import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runSyncHealthCheck } from "@/lib/tiktok/health";

// POST/GET /api/automation/sync-health-check — the TikTok sync watchdog.
//
// automation's daily schedule calls this ONE bearer-authed endpoint (the same
// "Mthryve OS Automation Key" as the Daily Tap, opportunities and probation
// gateways); it never touches the database directly and NEVER gets the
// service-role key. On the OS side we READ the run-level classification the
// sync now records and, for each syncing org, alert leadership (CEO + COO, bell
// + one Telegram broadcast) when the last scheduled run is MISSING/stale (>26h)
// or classified FAILED. We also WARN when any active connection's access token
// expires within 48h — before it lapses and the next sync bounces to /login.
//
// GUARDRAILS: read-only (never touches TikTok, never mutates a sync row),
// best-effort notifications (a failed bell/Telegram never fails the check), and
// idempotent — one alert per (incident, day), so a re-fire re-alerts no one.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Constant-time bearer check against AUTOMATION_API_KEY. Fails CLOSED when the
// secret isn't configured, so a missing env var can never open the gate. Mirrors
// the Daily Tap / probation-scan gateways exactly.
function bearerOk(req: NextRequest): boolean {
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

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!bearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const summary = await runSyncHealthCheck();
  return NextResponse.json(summary);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

// Support GET too, so a plain scheduled GET (or a manual curl) drives it.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
