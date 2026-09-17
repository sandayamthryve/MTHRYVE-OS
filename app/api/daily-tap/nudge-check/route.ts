import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runNudgeCheck } from "@/lib/daily-tap/read";
import { todayManila } from "@/lib/metrics/windows";

// GET /api/daily-tap/nudge-check — the in-app snooze poller.
//
// The app shell calls this after login (on load, then every 20 minutes). If the
// signed-in user's tap for today is UNACTED, under the 3× snooze cap, and at
// least 20 minutes have passed since the last nudge, it re-shows the tap and
// advances the snooze counter. IN-APP ONLY — it never re-sends the email.
//
// SELF-ONLY: the target user is taken from the verified session, never from
// request input. The READ of today's tap runs on the authed client, so the
// daily_taps self-only READ policy enforces it in the database; the snooze
// increment runs on the service-role client because daily_taps has no write
// policy. Both are still scoped to the session user's own row.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ nudge: false, reason: "unauthenticated" }, { status: 401 });
  }
  const readDb = createServerSupabaseClient() as unknown as { from: (t: string) => any };
  const writeDb = createServiceRoleClient() as unknown as { from: (t: string) => any };
  const result = await runNudgeCheck(readDb, writeDb, profile.id, profile.org_id, todayManila());
  return NextResponse.json(result);
}
