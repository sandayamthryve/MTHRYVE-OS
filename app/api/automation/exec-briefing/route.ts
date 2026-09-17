import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runOrgBriefing } from "@/lib/briefings/org-briefing-core";

export const runtime = "nodejs";
// Read env fresh per request (Vercel "Sensitive" runtime-only vars) and never
// cache — this is a mutating write, not a static read.
export const dynamic = "force-dynamic";
// One Anthropic call per org, folded sequentially; give it room but it stays far
// lighter than the TikTok pull.
export const maxDuration = 300;

// POST/GET /api/automation/exec-briefing — the daily EXECUTIVE-BRIEFING refresh.
//
// Regenerates the org-wide executive briefing (org_briefings) so the cached
// narrative on the Command Center never goes stale silently. It reuses the ONE
// shared generation core (lib/briefings/org-briefing-core → runOrgBriefing), the
// SAME grounded prompt and canonical sources the interactive "Refresh briefing"
// button uses — the machine run and a human refresh can never diverge.
//
// Two ways in — byte-for-byte the SAME constant-time auth block as the
// department-health rollup (/api/automation/metrics-rollup):
//   • A MACHINE trigger sends `Authorization: Bearer <secret>` and runs across
//     ALL orgs. The secret may be CRON_SECRET or AUTOMATION_API_KEY (the GitHub Actions
//     Schedule already holds the latter). Both are server-side machine secrets,
//     compared in constant time.
//   • A leadership session POSTs to refresh only the caller's own org.
// Anything else is rejected 401.
//
// SCHEDULE: driven by the SAME external GitHub Actions schedule as metrics-rollup — pair the
// two so every day's rollup is followed by a briefing refresh over fresh figures.
// NO VERCEL CRON (Vercel Hobby rejects sub-daily schedules; that broke a deploy
// once) — see docs/INTEGRATION_PLAN.
//
// MODEL: the machine run uses claude-opus-4-8 (the org/leadership tier), matching
// what a CEO refresh would pick; a session refresh keeps its role-derived model
// through the server action, not this route.
const MACHINE_MODEL = "claude-opus-4-8";

function cronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}
function automationApiKey(): string | undefined {
  return process.env.AUTOMATION_API_KEY?.trim() || undefined;
}

// Constant-time check that the Authorization header is `Bearer <expected>`.
// Copied from /api/automation/metrics-rollup — fails closed on a missing secret.
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
    // A manual refresh only touches the caller's own org.
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

  console.info("[exec-briefing] start", {
    mode: isMachine ? "machine" : "manual",
    org: orgScope ?? "all",
    orgs: orgIds.length,
  });

  // Fold every org in isolation — one org's AI failure must not abort the run
  // (runOrgBriefing already records an honest note on failure rather than throw).
  const results: { org: string; status: string; data_confidence?: string; error?: string }[] = [];
  for (const org of orgIds) {
    try {
      const r = await runOrgBriefing(client, {
        orgId: org,
        model: MACHINE_MODEL,
        generatedBy: null,
      });
      results.push({ org, status: r.status, data_confidence: r.data_confidence });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({ org, status: "error", error: message });
      console.error("[exec-briefing] org failed", { org, message });
    }
  }

  const anyError = results.some((r) => r.status === "error");
  console.info("[exec-briefing] done", {
    orgs: orgIds.length,
    generated: results.filter((r) => r.status === "generated").length,
    insufficient: results.filter((r) => r.status === "insufficient").length,
    errors: results.filter((r) => r.status === "error").length,
  });

  return NextResponse.json({
    status: anyError ? "partial" : "success",
    orgs: orgIds.length,
    results,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}

// Support GET too, so a plain scheduled GET (or a manual curl) drives it.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
