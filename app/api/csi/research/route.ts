import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual, randomUUID } from "crypto";
import { getSessionProfile } from "@/lib/auth/session";
import { research, CsiConfigError } from "@/lib/csi/research";
import { saveFindings } from "@/lib/csi/persist";
import type { CsiJobType, CsiResearchInput, CsiFinding } from "@/lib/csi/types";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { recordAiUsage } from "@/lib/security/events";
import { filterOutput } from "@/lib/security/output-filter";
import { TIER_MODEL } from "@/lib/ai/models";
import { verifyRequestSignature } from "@/lib/webhooks/signature";

const ResearchSchema = z.object({
  job_type: z.enum(["trend", "business_opportunity"]),
  query: z.string().min(1).max(2_000),
  brand_id: z.string().max(200).nullish(),
  max_results: z.number().int().positive().max(100).optional(),
});

// POST /api/csi/research — run Agent CSI's grounded deep research and store any
// verifiable findings.
//
// Two ways to authenticate (either is sufficient):
//   1. An authenticated OS session whose role is ceo / coo / department_head.
//   2. Authorization: Bearer <AUTOMATION_API_KEY> — the same shared-secret gate
//      as /api/automation/opportunities, so GitHub Actions can drive CSI in Phase 2. GitHub Actions
//      gets ONLY this bearer, never the service-role key.
//
// Flow: mint a run_id → research() (web-search grounded) → saveFindings()
// (service role) → return the result. It NEVER fabricates: if web search yields
// nothing verifiable, it returns inserted:0 with an honest message.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Web search + generation can take a while; give it headroom (still well under
// the 300s ceiling ingestion uses).
export const maxDuration = 120;

// Single-org for the bearer path, matching /api/automation/opportunities — later
// this resolves from a source→org mapping. Session callers use their own org.
const DEFAULT_ORG_ID = "146ab645-a5b8-4916-85c0-4ebd91480478";
const WRITE_ROLES = ["ceo", "coo", "department_head"] as const;

// Constant-time bearer check against AUTOMATION_API_KEY — copied verbatim from
// /api/automation/opportunities so both automation gateways behave identically.
// Fails CLOSED when the secret isn't configured.
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

function isJobType(v: unknown): v is CsiJobType {
  return v === "trend" || v === "business_opportunity";
}

// brand_id is a uuid column — a non-uuid value would fail the whole insert
// batch (notably on the GitHub Actions bearer path). Accept only a well-formed uuid, else
// treat brand_id as absent rather than poisoning the run.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validBrandId(v: unknown): string | null {
  return typeof v === "string" && UUID_RE.test(v.trim()) ? v.trim() : null;
}

export async function POST(req: NextRequest) {
  // 1) AUTH — leadership/department-head session OR the automation bearer.
  const profile = await getSessionProfile();
  const sessionOk = !!profile && (WRITE_ROLES as readonly string[]).includes(profile.role);
  const bearer = bearerOk(req);
  if (!sessionOk && !bearer) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Read the raw body once — needed both to verify the GitHub Actions HMAC and to parse.
  const rawBody = await req.text();

  // 1b) SIGNATURE — on the automation (GitHub Actions) path, require a valid HMAC over the
  // raw body with WEBHOOK_SIGNING_SECRET, in addition to the bearer. A browser
  // leadership session is exempt (it can't sign). Fails closed when unset.
  if (!sessionOk && bearer && !verifyRequestSignature(req.headers, rawBody)) {
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  // 2) Surface a missing key explicitly, the way the AI assistant route does —
  // never silently fail or fabricate.
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        ok: false,
        error: "not-configured",
        message: "Agent CSI isn't configured yet. Add ANTHROPIC_API_KEY in Vercel.",
      },
      { status: 503 }
    );
  }

  // 3) Parse + validate the body.
  let body: Record<string, unknown>;
  try {
    const raw = JSON.parse(rawBody);
    const parsed = ResearchSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    body = parsed.data as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (!isJobType(body.job_type)) {
    return NextResponse.json(
      { ok: false, error: "job_type must be 'trend' or 'business_opportunity'" },
      { status: 400 }
    );
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json({ ok: false, error: "query is required" }, { status: 400 });
  }

  const input: CsiResearchInput = {
    job_type: body.job_type,
    query,
    brand_id: validBrandId(body.brand_id),
    max_results: typeof body.max_results === "number" ? body.max_results : undefined,
  };

  const orgId = sessionOk ? profile!.org_id : DEFAULT_ORG_ID;
  const createdBy = sessionOk ? profile!.id : null;
  const runId = randomUUID();

  // 4) Research — grounded, web-search backed. Record usage (Part D) via the
  // service-role client (this path can be a cookie-less GitHub Actions bearer call).
  let findings;
  try {
    findings = await research(input, (usage) => {
      void recordAiUsage(createServiceRoleClient() as unknown as { from: (t: string) => any }, {
        orgId,
        userId: createdBy,
        feature: "csi",
        model: TIER_MODEL.standard,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    });
  } catch (e) {
    if (e instanceof CsiConfigError) {
      return NextResponse.json(
        {
          ok: false,
          error: "not-configured",
          message: "Agent CSI isn't configured yet. Add ANTHROPIC_API_KEY in Vercel.",
        },
        { status: 503 }
      );
    }
    // Log the detail server-side; return a generic message (never leak internals).
    console.error("[csi/research]", e);
    // Fail safe — never fabricate to fill the response.
    return NextResponse.json(
      { ok: false, run_id: runId, inserted: 0, skipped: 0, findings: [], error: "research failed" },
      { status: 502 }
    );
  }

  // 5) Nothing verifiable — honest empty result, nothing stored.
  if (findings.length === 0) {
    return NextResponse.json({
      ok: true,
      run_id: runId,
      inserted: 0,
      skipped: 0,
      findings: [],
      message:
        "No verifiable sourced findings this run. Nothing was stored — Agent CSI never fabricates to fill the feed.",
    });
  }

  // 6) Part C: redact any leaked secret / sensitive number from the model-written
  // finding text before it is persisted or returned.
  const safeFindings: CsiFinding[] = findings.map((f) => ({
    ...f,
    title: filterOutput(f.title).text,
    summary: filterOutput(f.summary).text,
    source_title: f.source_title ? filterOutput(f.source_title).text : f.source_title,
  }));

  // 7) Persist and report.
  const { inserted, skipped } = await saveFindings(orgId, runId, createdBy, safeFindings);
  return NextResponse.json({ ok: true, run_id: runId, inserted, skipped, findings: safeFindings });
}
