import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  listProbationQueue,
  resolveHrAdminHeadId,
} from "@/lib/people/probation";
import { notifyProbationReviewDue } from "@/lib/notifications/producers";

// POST /api/automation/probation-review-scan — the daily probation auto-flag.
//
// automation's daily schedule calls this ONE bearer-authed endpoint (same
// "Mthryve OS Automation Key" as the Daily Tap and the opportunities gateway);
// it never touches the database and NEVER gets the service-role key. On the OS
// side we read every org's probation queue READ-ONLY, and for each hire whose
// probation_end is inside the 14-day window (upcoming OR lapsed) we notify HR —
// leadership (ceo/coo) plus the HR & Admin department head. The notification is
// de-duped per (hire, day), so a re-fire the same day re-flags no one.
//
// GUARDRAILS: read-only (the scan never transitions anyone — a human records the
// decision in the queue), best-effort notifications (a failed bell never fails
// the scan), and org-scoped throughout (the HR head is resolved per org).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Shim = { from: (t: string) => any };

// Constant-time bearer check against AUTOMATION_API_KEY. Fails CLOSED when the
// secret isn't configured, so a missing env var can never open the gate.
// Mirrors the Daily Tap / opportunities gateways exactly.
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

export async function POST(req: NextRequest) {
  if (!bearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = createServiceRoleClient() as unknown as Shim;

  // Discover the orgs to scan. Every hire carries their org, so the distinct set
  // of org_ids on users is exactly the tenant list (single-org today, but the
  // scan stays multi-org safe by resolving the HR head per org).
  const { data: userRows, error } = await db.from("users").select("org_id");
  if (error) {
    return NextResponse.json({ ok: false, error: "could not read users" }, { status: 500 });
  }
  const orgIds = Array.from(
    new Set(
      ((userRows ?? []) as Array<{ org_id: string | null }>)
        .map((u) => u.org_id)
        .filter((id): id is string => !!id)
    )
  );

  let flagged = 0;
  let notified = 0;
  for (const orgId of orgIds) {
    const [queue, hrHeadId] = await Promise.all([
      listProbationQueue(db, orgId),
      resolveHrAdminHeadId(db, orgId),
    ]);
    const due = queue.filter((r) => r.reviewDue);
    for (const hire of due) {
      flagged += 1;
      notified += await notifyProbationReviewDue(
        {
          orgId,
          userId: hire.id,
          personName: hire.full_name,
          daysLeft: hire.daysLeft,
          hrHeadId,
        },
        db
      );
    }
  }

  return NextResponse.json({
    ok: true as const,
    orgs: orgIds.length,
    flagged, // hires inside the review window this run
    notified, // notification rows written (after per-recipient de-dupe)
  });
}
