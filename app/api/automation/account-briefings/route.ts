import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runAccountBriefing } from "@/lib/briefings/account-briefing-core";

export const runtime = "nodejs";
// Read env fresh per request (Vercel "Sensitive" runtime-only vars) and never
// cache — this is a mutating write, not a static read.
export const dynamic = "force-dynamic";
// One Anthropic call per brand, folded sequentially; give it room but each call
// stays far lighter than the TikTok pull.
export const maxDuration = 300;

// POST/GET /api/automation/account-briefings — the daily ACCOUNT-BRIEFING refresh.
//
// Regenerates every brand's account briefing (account_briefings) so the cached,
// CLIENT-FACING narrative on the Accounts page never goes stale silently. It reuses
// the ONE shared generation core (lib/briefings/account-briefing-core →
// runAccountBriefing), the SAME grounded prompt and canonical sources the
// interactive "Refresh briefing" button uses — the machine run and a human refresh
// can never diverge.
//
// Two ways in — byte-for-byte the SAME constant-time auth block as the executive-
// briefing refresh (/api/automation/exec-briefing) and the department-health rollup:
//   • A MACHINE trigger sends `Authorization: Bearer <secret>` and runs across ALL
//     brands in ALL orgs. The secret may be CRON_SECRET or AUTOMATION_API_KEY (the
//     GitHub Actions schedule already holds the latter). Both are server-side machine secrets,
//     compared in constant time.
//   • A leadership session POSTs to refresh only the caller's own org's brands.
// Anything else is rejected 401.
//
// SCHEDULE: driven by the SAME external GitHub Actions schedule as metrics-rollup / exec-
// briefing — pair them so every day's rollup is followed by fresh briefings over
// fresh figures. NO VERCEL CRON (Vercel Hobby rejects sub-daily schedules) — see
// docs/INTEGRATION_PLAN.
//
// MODEL: the machine run uses claude-opus-4-8 (the leadership tier), matching what a
// CEO refresh would pick; a session refresh keeps its role-derived model through the
// server action, not this route.
const MACHINE_MODEL = "claude-opus-4-8";

function cronSecret(): string | undefined {
  return process.env.CRON_SECRET?.trim() || undefined;
}
function automationApiKey(): string | undefined {
  return process.env.AUTOMATION_API_KEY?.trim() || undefined;
}

// Constant-time check that the Authorization header is `Bearer <expected>`.
// Copied from /api/automation/exec-briefing — fails closed on a missing secret.
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

  // Which brands. A machine run spans every brand in every org; a scoped run touches
  // only the caller's own org's brands. Archived brands are skipped — a retired
  // client needs no fresh briefing.
  let brandQuery = client
    .from("brands")
    .select("id, org_id")
    .is("archived_at", null);
  if (orgScope) brandQuery = brandQuery.eq("org_id", orgScope);
  const { data: brandData, error: brandErr } = await brandQuery;
  if (brandErr) {
    return NextResponse.json({ error: "load_brands_failed", detail: brandErr }, { status: 500 });
  }
  const brands = ((brandData ?? []) as { id: string | null; org_id: string | null }[]).filter(
    (b): b is { id: string; org_id: string } =>
      typeof b.id === "string" && b.id.length > 0 && typeof b.org_id === "string" && b.org_id.length > 0
  );

  console.info("[account-briefings] start", {
    mode: isMachine ? "machine" : "manual",
    org: orgScope ?? "all",
    brands: brands.length,
  });

  // Fold every brand in isolation — one brand's AI failure must not abort the run
  // (runAccountBriefing records an honest note on failure rather than throw).
  const results: { brand: string; status: string; data_confidence?: string; error?: string }[] = [];
  for (const b of brands) {
    try {
      const r = await runAccountBriefing(client, {
        orgId: b.org_id,
        brandId: b.id,
        model: MACHINE_MODEL,
        generatedBy: null,
      });
      results.push({ brand: b.id, status: r.status, data_confidence: r.data_confidence });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({ brand: b.id, status: "error", error: message });
      console.error("[account-briefings] brand failed", { brand: b.id, message });
    }
  }

  const anyError = results.some((r) => r.status === "error");
  console.info("[account-briefings] done", {
    brands: brands.length,
    generated: results.filter((r) => r.status === "generated").length,
    insufficient: results.filter((r) => r.status === "insufficient").length,
    errors: results.filter((r) => r.status === "error").length,
  });

  return NextResponse.json({
    status: anyError ? "partial" : "success",
    brands: brands.length,
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
