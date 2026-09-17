import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { markTapActed } from "@/lib/daily-tap/read";
import { todayManila } from "@/lib/metrics/windows";

// POST /api/daily-tap/acted — mark the signed-in user's tap for today as ACTED.
//
// Called when the user completes today's action (opens the linked brief from the
// tap / nudge toast). Quick Entry saves mark it server-side too. Once acted, the
// in-app snooze cadence stops. Idempotent, and SELF-ONLY: the target user comes
// from the verified session, never from request input.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }
  const db = createServiceRoleClient() as unknown as { from: (t: string) => any };
  const acted = await markTapActed(db, profile.id, profile.org_id, todayManila());
  return NextResponse.json({ ok: true, acted });
}
