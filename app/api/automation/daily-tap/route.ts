import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { buildTap } from "@/lib/daily-tap/build";
import { deliverTap, type DeliverResult } from "@/lib/daily-tap/deliver";
import { todayManila } from "@/lib/metrics/windows";
import type { TapUser } from "@/lib/daily-tap/types";

// POST /api/automation/daily-tap — the Daily AI Tap trigger.
//
// automation's morning schedule (≈10 AM Manila) calls this ONE bearer-authed endpoint;
// it never touches the database and NEVER gets the service-role key. On the OS
// side we build each active user's morning tap READ-ONLY from real rows, deliver
// it in-app (a notifications row) and by email (when the Resend sender is
// configured), and record ONE daily_taps row per (user, day) — idempotent, so a
// re-fire re-taps no one.
//
// GUARDRAILS: read-only (the tap never acts), honest nulls (no data → "log
// today's numbers", never a fabricated figure), money stays gated (a leadership
// tap SURFACES the pending-approval count, it never approves), and exactly ONE
// model call — a Sonnet synthesis for ceo/coo; everyone else is templated.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Shim = { from: (t: string) => any };

// Employment statuses that mean "not active". A null / unset status is treated
// as active (honest default — the roster hasn't marked them inactive).
const INACTIVE_STATUSES = new Set(["inactive", "terminated", "resigned", "separated", "ended", "offboarded", "released"]);

// Constant-time bearer check against AUTOMATION_API_KEY. Fails CLOSED when the
// secret isn't configured, so a missing env var can never open the gate. Mirrors
// the opportunities gateway exactly (same GitHub Actions "Mthryve OS Automation Key").
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

function isActive(u: { employment_status: string | null }): boolean {
  const s = (u.employment_status ?? "").trim().toLowerCase();
  return s === "" || !INACTIVE_STATUSES.has(s);
}

export async function POST(req: NextRequest) {
  if (!bearerOk(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const db = createServiceRoleClient() as unknown as Shim;
  const today = todayManila();

  // Every active user, org carried per row (multi-org safe — buildTap/deliverTap
  // scope every read/write to user.org_id).
  const { data: userRows, error } = await db
    .from("users")
    .select("id, org_id, department_id, full_name, email, role, employment_status");
  if (error) {
    return NextResponse.json({ ok: false, error: "could not read users" }, { status: 500 });
  }

  const users = ((userRows ?? []) as TapUser[]).filter(
    (u) => u.id && u.org_id && u.role && isActive(u)
  );

  // Sequential: only the two leadership taps spend a model call, and a steady
  // pace keeps the Anthropic + email providers well within rate limits. A single
  // user's failure is recorded and never aborts the run.
  const results: DeliverResult[] = [];
  for (const user of users) {
    try {
      const tap = await buildTap(db, user, today);
      results.push(await deliverTap(db, user, tap, today));
    } catch (e) {
      results.push({
        userId: user.id,
        outcome: "failed",
        channels: [],
        tier: null,
        aiUsed: false,
        error: e instanceof Error ? e.message : "build/deliver threw",
      });
    }
  }

  const summary = {
    ok: true as const,
    tap_date: today,
    active_users: users.length,
    created: results.filter((r) => r.outcome === "created").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    ai_calls: results.filter((r) => r.aiUsed).length,
  };
  return NextResponse.json(summary);
}
