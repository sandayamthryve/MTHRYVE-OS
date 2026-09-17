import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { getSessionProfile } from "@/lib/auth/session";
import { composeOrgDigests } from "@/lib/notifications/digest";
import type { Shim } from "@/lib/notifications/notify";

// POST/GET /api/notifications/digest — the MORNING BRIEFING job.
//
// It sweeps every org's real overdue tasks / cases / SLA breaches (firing the
// per-item producers) and then composes a per-role, data-grounded morning
// digest notification for each user (CEO/COO get the 'deep' read; everyone else
// a scoped mini-Tony). Two ways in, exactly like the Automation Radar scan:
//   • Vercel Cron (see vercel.json) sends `Authorization: Bearer ${CRON_SECRET}`
//     → runs across EVERY org.
//   • a signed-in leader (ceo/coo) → runs for THEIR org only (a manual "send
//     today's briefing" trigger).
//
// Grounded + safe: composeOrgDigests only reads real rows and never invents a
// number; every notification is best-effort and points at a real entity. No
// action is executed — a pending_approval notification still routes through the
// approval spine.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  const exp = expected?.trim();
  const prov = provided?.trim();
  if (!exp || !prov) return false;
  const a = Buffer.from(prov);
  const b = Buffer.from(exp);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerOk(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const provided = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!provided) return false;
  return (
    secretMatches(provided, process.env.CRON_SECRET) ||
    secretMatches(provided, process.env.AUTOMATION_API_KEY)
  );
}

async function allOrgIds(db: Shim): Promise<string[]> {
  try {
    const { data } = await db.from("organizations").select("id");
    return ((data as Array<{ id: string }> | null) ?? []).map((o) => o.id);
  } catch {
    return [];
  }
}

async function handle(req: NextRequest) {
  const db = createServiceRoleClient() as unknown as Shim;

  // Path 1: shared cron bearer → every org.
  if (bearerOk(req)) {
    const orgs = await allOrgIds(db);
    const summaries = [];
    for (const orgId of orgs) {
      summaries.push(await composeOrgDigests(db, orgId));
    }
    return NextResponse.json({ ok: true, scope: "all_orgs", orgs: orgs.length, summaries });
  }

  // Path 2: a signed-in leader → their org only.
  const profile = await getSessionProfile();
  if (!profile || !["ceo", "coo"].includes(profile.role)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const summary = await composeOrgDigests(db, profile.org_id);
  return NextResponse.json({ ok: true, scope: "org", summary });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
