import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getSessionProfile } from "@/lib/auth/session";
import { detectForOrg, runAnomalyScan } from "@/lib/security/anomaly";

// POST/GET /api/security/anomaly-scan — runs the anomaly monitor (PASTE 4.3
// Part D). Mirrors /api/automation-radar/scan. Two ways in:
//   • Vercel Cron (vercel.json) sends `Authorization: Bearer ${CRON_SECRET}`
//     (or AUTOMATION_API_KEY) → sweep EVERY org.
//   • a signed-in leader (CEO/COO) → scan THEIR org only (a "Run scan" button).
//
// The monitor is READ-ONLY over the signal tables (ai_usage_log, security_events),
// UPSERTS alerts into security_anomalies, and notifies leadership on newly-raised
// ones. It never executes or blocks anything.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Shim = { from: (t: string) => any };

// Constant-time compare, fails CLOSED when the expected secret is unset.
function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  const exp = expected?.trim();
  const prov = provided?.trim();
  if (!exp || !prov) return false;
  const a = Buffer.from(prov);
  const b = Buffer.from(exp);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Accept a Vercel-cron bearer (CRON_SECRET) or the shared AUTOMATION_API_KEY.
function bearerOk(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const provided = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!provided) return false;
  return (
    secretMatches(provided, process.env.CRON_SECRET) ||
    secretMatches(provided, process.env.AUTOMATION_API_KEY)
  );
}

async function handle(req: NextRequest) {
  // Path 1: shared bearer secret → full org-wide sweep (cron).
  if (bearerOk(req)) {
    const db = createServiceRoleClient() as unknown as Shim;
    const summaries = await runAnomalyScan(db);
    const raised = summaries.reduce((a, s) => a + s.raised, 0);
    return NextResponse.json({ ok: true, scope: "all_orgs", raised, summaries });
  }

  // Path 2: a signed-in leader → scan their org only.
  const profile = await getSessionProfile();
  if (!profile || !["ceo", "coo"].includes(profile.role)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceRoleClient() as unknown as Shim;
  const summary = await detectForOrg(db, profile.org_id);
  return NextResponse.json({ ok: true, scope: "own_org", summary });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
