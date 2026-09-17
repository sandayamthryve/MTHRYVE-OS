import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getSessionProfile } from "@/lib/auth/session";
import { detectForOrg, runDetection } from "@/lib/automation-radar/detect";

// POST/GET /api/automation-radar/scan — runs the ONE org-wide Automation Radar
// detector. Two ways in:
//   • Vercel Cron (see vercel.json) sends `Authorization: Bearer ${CRON_SECRET}`
//     (or the AUTOMATION_API_KEY the Opportunity Engine uses) → detection across
//     EVERY org.
//   • a signed-in leader (CEO/COO/department head) → runs detection for THEIR org
//     only (the "Run detection" button on the Automation Radar page).
//
// Detection is deterministic and READ-ONLY over real tasks; it only UPSERTS
// repetition_patterns. Nothing is executed and nothing is proposed here — the
// proposal step (a pending action_request) is human-driven in the surface.

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
    const summaries = await runDetection(db);
    return NextResponse.json({ ok: true, scope: "all_orgs", summaries });
  }

  // Path 2: a signed-in leader → detect for their org only.
  const profile = await getSessionProfile();
  if (!profile || !["ceo", "coo", "department_head"].includes(profile.role)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Detection is a trusted system job (reads org-wide, writes leadership-gated
  // rows), so it runs under the service-role client scoped to the caller's org.
  const db = createServiceRoleClient() as unknown as Shim;
  const summary = await detectForOrg(db, profile.org_id);
  return NextResponse.json({ ok: true, scope: "org", summary });
}

// Vercel Cron issues a GET; the "Run detection" button POSTs. Both share `handle`.
export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
