import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  escalationCandidates,
  outcomeCandidates,
  OUTCOME_STATUS_LIST,
  type SweepRow,
} from "@/lib/automation/approval-sweep";
import {
  notifyApprovalEscalation,
  notifyRequesterOutcome,
} from "@/lib/notifications/producers";

export const runtime = "nodejs";
// Two bounded queries per org + best-effort bells. Never cached.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST/GET /api/automation/approval-sweep — the daily Approval Routing agent's
// closing loop (docs/AI_AGENTS.md Agent 3).
//
// The routing half already exists: producers draft action_requests and
// notifyPendingApproval pings the decidable roles the moment a request lands.
// What was missing was TIME: nothing nudged when a request sat ignored, and the
// filer had to poll the queue to learn what happened. This sweep closes both:
//
//   1. ESCALATE — every org's requests still pending (incl. governed
//      pending_coo/pending_ceo stages) older than APPROVAL_ESCALATION_HOURS
//      (default 48) re-notify exactly the roles that may decide them, warning-
//      severity, de-duped so the daily re-fire never stacks.
//   2. REPORT BACK — requests that reached a TERMINAL decision in the last 24h
//      (approved / executed / rejected / failed / expired / cancelled) get their
//      FILER told automatically — unless the filer decided it themselves.
//
// Nothing here decides or executes anything: escalation and outcome bells point
// at the same action_request rows; every decision still flows through the spine.
//
// Auth mirrors /api/automation/metric-briefs exactly — machine bearer runs ALL
// orgs, leadership session runs only its own. Driven by the GitHub Actions
// scheduler; NO VERCEL CRON (Hobby rejects sub-daily schedules).

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

// Escalation threshold, env-overridable without a code change. A nonsense value
// falls back to the documented default rather than disabling the sweep.
function escalationHours(): number {
  const raw = Number(process.env.APPROVAL_ESCALATION_HOURS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 48;
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
    orgScope = profile.org_id;
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const client = createServiceRoleClient() as unknown as { from: (t: string) => any };

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

  const hours = escalationHours();
  const now = new Date();
  const cutoffIso = new Date(now.getTime() - hours * 3600_000).toISOString();
  const sinceIso = new Date(now.getTime() - 24 * 3600_000).toISOString();

  console.info("[approval-sweep] start", {
    mode: isMachine ? "machine" : "manual",
    org: orgScope ?? "all",
    orgs: orgIds.length,
    escalationAfterHours: hours,
  });

  let escalated = 0;
  let reported = 0;
  const failures: { org: string; error: string }[] = [];

  for (const orgId of orgIds) {
    try {
      // ── Pass 1: escalate stale pendings ────────────────────────────────────
      const pendRes = await client
        .from("action_requests")
        .select("id, title, status, created_at, created_by, decided_by, decided_at")
        .eq("org_id", orgId)
        .in("status", ["pending", "pending_coo", "pending_ceo"])
        .lte("created_at", cutoffIso);
      if (pendRes.error) throw new Error(`escalation query: ${pendRes.error.message}`);

      for (const cand of escalationCandidates(pendRes.data as SweepRow[], now, hours)) {
        escalated += await notifyApprovalEscalation({
          orgId,
          actionRequestId: cand.id,
          title: cand.title,
          requiredRole: (cand as unknown as { required_role?: string | null }).required_role ?? null,
          ageHours: cand.ageHours,
        });
      }

      // ── Pass 2: report terminal outcomes to their filers ───────────────────
      const decRes = await client
        .from("action_requests")
        .select("id, title, status, decision_note, created_at, created_by, decided_by, decided_at")
        .eq("org_id", orgId)
        .in("status", OUTCOME_STATUS_LIST)
        .gte("decided_at", sinceIso);
      if (decRes.error) throw new Error(`outcome query: ${decRes.error.message}`);

      for (const { row, kind } of outcomeCandidates(decRes.data as SweepRow[], sinceIso)) {
        if (!row.created_by) continue; // nobody to report to (system-filed)
        reported += await notifyRequesterOutcome({
          orgId,
          actionRequestId: row.id,
          requesterId: row.created_by,
          requestTitle: row.title,
          kind,
          note: (row as unknown as { decision_note?: string | null }).decision_note ?? null,
        });
      }
    } catch (err) {
      // One org's failure must not abort the others — collect and continue.
      failures.push({ org: orgId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.info("[approval-sweep] done", { escalated, reported, failed: failures.length });

  // Doctrine #10 (no silent failure): both passes wrote NOTHING while at least
  // one org failed → turn the scheduler RED. Partial success still succeeds.
  if (failures.length > 0 && escalated === 0 && reported === 0) {
    return NextResponse.json(
      { status: "failed", escalated, reported, failed: failures.length, errors: failures },
      { status: 502 }
    );
  }

  return NextResponse.json({
    status: "ok",
    escalated,
    reported,
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
