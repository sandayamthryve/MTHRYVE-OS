import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth/session";
import { parseJsonBody, serverError } from "@/lib/security/api";
import { loadReviewData, type ReviewData } from "@/lib/metrics/review";
import { generateAccountReviewBrief } from "@/lib/briefings/account-review";
import { generateScenarios, SCENARIO_TIER } from "@/lib/briefings/account-review-scenarios";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";

const BriefSchema = z.object({
  department: z.string().max(120).optional(),
  department_id: z.string().max(200).nullish(),
  brand_id: z.string().max(200).nullish(),
  period_start: z.string().max(40).optional(),
  period_end: z.string().max(40).optional(),
});

// POST /api/metrics/brief — generate + persist an AI Account Review Brief.
// GET  /api/metrics/brief?id=<uuid> — re-open a persisted brief (history).
//
// The Anthropic call happens entirely server-side (lib/briefings/account-review
// → the shared ANTHROPIC_API_KEY path); the key is never sent to the client. The
// brief is grounded ONLY in real metric rows (lib/metrics/review) and persisted
// to account_review_briefs. RLS scopes every read/write to the caller's org.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// account_review_briefs isn't in the generated Database types yet — reach it via
// the same cast shim the rest of the Actions/Metrics layer uses.
type Shim = { from: (t: string) => any };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: NextRequest) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // Generation is a leadership action (mirrors metrics recording RBAC).
  if (!["ceo", "coo", "department_head"].includes(profile.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = await parseJsonBody(req, BriefSchema, "metrics/brief");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const department = (body.department ?? "").trim();
  const period_start = (body.period_start ?? "").trim();
  const period_end = (body.period_end ?? "").trim();
  if (!department || !DATE_RE.test(period_start) || !DATE_RE.test(period_end)) {
    return NextResponse.json({ error: "department, period_start and period_end (YYYY-MM-DD) are required" }, { status: 400 });
  }
  if (period_end < period_start) {
    return NextResponse.json({ error: "period_end must be on/after period_start" }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Resolve the department name → id within the caller's org (unless it's the
  // explicit org-level scope). RLS already scopes departments to the org.
  let department_id: string | null = body.department_id ?? null;
  const isOrgScope = department.toLowerCase() === "organization" || department.toLowerCase() === "all departments";
  if (!department_id && !isOrgScope) {
    const { data: dept } = await db
      .from("departments")
      .select("id")
      .ilike("name", department)
      .maybeSingle();
    department_id = (dept as { id?: string } | null)?.id ?? null;
    if (!department_id) {
      return NextResponse.json({ error: `unknown department "${department}"` }, { status: 400 });
    }
  }

  const brand_id = (body.brand_id ?? "").toString().trim() || null;

  let review: ReviewData;
  try {
    review = await loadReviewData(db, { department, department_id, brand_id, period_start, period_end });
  } catch (e) {
    return serverError("metrics/brief.load", e, 500, "Failed to load metrics.");
  }

  const model = TIER_MODEL[defaultTierFor(profile.role)];
  const payload = await generateAccountReviewBrief(review, { model });

  // AI Brief 2.0 — attach the best/base/worst scenarios, generated on the DEEP
  // tier over the same grounded review data. Never throws; on a thin scope or
  // AI outage it returns honest, low-confidence, deterministic scenarios. Only
  // spend the deep-tier call when the base brief itself is grounded (there is
  // real data to project over) — a no-data brief keeps its empty scenario block.
  if (payload.meta.grounded) {
    const { scenarios, meta: scenario_meta } = await generateScenarios(review, {
      model: TIER_MODEL[SCENARIO_TIER],
    });
    payload.scenarios = scenarios;
    payload.scenario_meta = scenario_meta;
  }

  // Persist the structured brief. summary mirrors the executive summary for the
  // history list; payload holds the full structured result + the grounded scope.
  const { data: inserted, error } = await db
    .from("account_review_briefs")
    .insert({
      org_id: profile.org_id,
      department,
      brand_id,
      period_start,
      period_end,
      summary: payload.executive_summary,
      payload: { ...payload, scope: review.scope, entries: review.entries, rollup: review.rollup, mismatch_flags: review.mismatch_flags },
      generated_by: profile.id,
    })
    .select("id, created_at")
    .single();

  if (error) {
    return serverError("metrics/brief.insert", error, 500, "Could not save the brief.");
  }
  const row = inserted as { id: string; created_at: string };

  return NextResponse.json({
    brief_id: row.id,
    created_at: row.created_at,
    scope: review.scope,
    entries: review.entries,
    rollup: review.rollup,
    mismatch_flags: review.mismatch_flags,
    payload,
  });
}

export async function GET(req: NextRequest) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;
  const { data, error } = await db
    .from("account_review_briefs")
    .select("id, department, brand_id, period_start, period_end, summary, payload, created_at")
    .eq("id", id)
    .maybeSingle();

  if (error) return serverError("metrics/brief.get", error, 500, "Could not load the brief.");
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  const row = data as {
    id: string;
    department: string;
    brand_id: string | null;
    period_start: string;
    period_end: string;
    summary: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  };
  const p = row.payload ?? {};
  return NextResponse.json({
    brief_id: row.id,
    created_at: row.created_at,
    scope: (p as any).scope ?? {
      department: row.department,
      brand_id: row.brand_id,
      period_start: row.period_start,
      period_end: row.period_end,
    },
    entries: (p as any).entries ?? [],
    rollup: (p as any).rollup ?? null,
    mismatch_flags: (p as any).mismatch_flags ?? [],
    payload: p,
  });
}
