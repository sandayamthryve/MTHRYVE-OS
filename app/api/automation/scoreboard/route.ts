import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { computeScoreboard } from "@/lib/vesper/scoreboard";
import { monthToDate } from "@/lib/metrics/windows";
import { formatScoreboardDigest } from "@/lib/automation/scoreboard-digest";
import { notifyWeeklyScoreboard } from "@/lib/notifications/producers";

export const runtime = "nodejs";
// Live reads across every org, then a bell per org. Never cached.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST/GET /api/automation/scoreboard — the WEEKLY Growth Scoreboard digest.
//
// Tony's cockpit (docs/AI_AGENTS.md Agent 1b) used to exist only when someone
// opened /scoreboard or asked Vesper to compile it. This route makes it a
// scheduled fact: every Monday morning leadership's bell carries the org's
// top-line playbook KPIs — computed live from the SAME engine the page renders
// (lib/vesper/scoreboard.ts), so the numbers can never disagree with what they
// see when they click through.
//
// Auth mirrors /api/automation/metric-briefs exactly — a constant-time machine
// bearer (CRON_SECRET or AUTOMATION_API_KEY) runs ALL orgs; a leadership session
// runs only the caller's own org. Anything else is 401. Driven by the GitHub
// Actions scheduler (.github/workflows/automation-schedule.yml); NO VERCEL CRON
// (Vercel Hobby rejects sub-daily schedules at deploy-parse time).
//
// Nothing here executes anything: the notification is a pointer to /scoreboard,
// exactly like every other producer in the OS.

function cronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}
function automationApiKey(): string | undefined {
  return process.env.AUTOMATION_API_KEY?.trim() || undefined;
}

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
    // A manual run only touches the caller's own org.
    orgScope = profile.org_id;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const client = createServiceRoleClient() as unknown as { from: (t: string) => any };

  // Which orgs. A machine run spans them all; a scoped run touches only its own.
  let orgIds: string[];
  if (orgScope) {
    orgIds = [orgScope];
  } else {
    const { data, error } = await client.from("organizations").select("id");
    if (error) {
      return NextResponse.json(
        { error: "load_organizations_failed", detail: error },
        { status: 500 }
      );
    }
    orgIds = ((data ?? []) as { id: string | null }[])
      .map((r) => r.id)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  }

  console.info("[scoreboard] start", {
    mode: isMachine ? "machine" : "manual",
    org: orgScope ?? "all",
    orgs: orgIds.length,
  });

  const window = monthToDate();
  // Stable dedupe key per (org, day): a manual re-run the same week doesn't stack
  // unread bells, while next Monday's board is always a fresh notification.
  const digestDay = new Date().toISOString().slice(0, 10);

  let notified = 0;
  const failures: { org: string; error: string }[] = [];

  for (const orgId of orgIds) {
    try {
      // The scoreboard engine accepts either an RLS-scoped client (page) or the
      // service-role client (executor) — reads stay org-scoped explicitly inside.
      const board = await computeScoreboard(client, orgId, window);
      const digest = formatScoreboardDigest(board);
      const wrote = await notifyWeeklyScoreboard({
        orgId,
        digestId: `weekly:${orgId}:${digestDay}`,
        title: digest.title,
        body: digest.body,
      });
      notified += wrote;
    } catch (err) {
      // One org's failure must not abort the others — collect and continue.
      failures.push({ org: orgId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.info("[scoreboard] done", { notified, failed: failures.length });

  // Doctrine #10 (no silent failure): a run that notified NOBODY while at least
  // one org failed did no work — turn the scheduler RED. Partial success still
  // succeeds; zero orgs / zero failures is a legitimate no-op.
  if (failures.length > 0 && notified === 0) {
    return NextResponse.json(
      { status: "failed", notified, failed: failures.length, errors: failures },
      { status: 502 }
    );
  }

  return NextResponse.json({
    status: "ok",
    notified,
    orgs: orgIds.length,
    failed: failures.length,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Support GET too, so a plain scheduled GET (or a manual curl) drives it.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
