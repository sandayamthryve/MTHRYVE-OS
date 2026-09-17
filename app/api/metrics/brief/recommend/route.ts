import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth/session";
import { parseJsonBody, serverError } from "@/lib/security/api";
import { writeActionAudit } from "@/lib/actions/audit";
import { buildRecommendationDraft } from "@/lib/briefings/account-review-action";
import type { BriefPayload } from "@/lib/briefings/account-review";

const RecommendSchema = z.object({
  brief_id: z.string().max(200).optional(),
  recommendation_index: z.union([z.number(), z.string().max(16)]).optional(),
});

// POST /api/metrics/brief/recommend — "Send to approval" for ONE recommendation.
//
// Staging only: this creates a PENDING action_request carrying Tony's reasoning
// and links back to the brief + target department. Nothing executes — there is
// no executor for source_module 'account_review', so even on human approval no
// money moves and no one is contacted (D-005). The recommendation is read from
// the PERSISTED brief (by index), not from the request body, so the client can't
// smuggle in an action the brief never made.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

export async function POST(req: NextRequest) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = await parseJsonBody(req, RecommendSchema, "metrics/brief/recommend");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const briefId = (body.brief_id ?? "").toString().trim();
  const index = Number(body.recommendation_index);
  if (!briefId || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "brief_id and recommendation_index are required" }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Load the persisted brief (RLS scopes to the caller's org).
  const { data: briefRow, error: briefErr } = await db
    .from("account_review_briefs")
    .select("id, department, brand_id, period_start, period_end, payload")
    .eq("id", briefId)
    .maybeSingle();
  if (briefErr) return serverError("metrics/brief/recommend.load", briefErr, 500, "Could not load the brief.");
  if (!briefRow) return NextResponse.json({ error: "brief not found" }, { status: 404 });

  const row = briefRow as {
    id: string;
    department: string;
    brand_id: string | null;
    period_start: string;
    period_end: string;
    payload: BriefPayload & { scope?: { brand_name?: string | null } };
  };
  const payload = row.payload;
  const rec = payload?.recommendations?.[index];
  if (!rec) return NextResponse.json({ error: "recommendation not found on this brief" }, { status: 404 });

  // Don't stack a duplicate for the same brief + recommendation.
  const { data: existing } = await db
    .from("action_requests")
    .select("id, source_ref, status")
    .eq("source_module", "account_review")
    .in("status", ["pending", "approved"]);
  const dup = ((existing ?? []) as Array<{ id: string; source_ref: Record<string, unknown> | null }>).find(
    (r) => r.source_ref?.brief_id === briefId && Number(r.source_ref?.recommendation_index) === index
  );
  if (dup) {
    return NextResponse.json({ action_request_id: dup.id, already: true });
  }

  const draft = buildRecommendationDraft({
    brief_id: row.id,
    brief: payload,
    recommendation: rec,
    index,
    department: row.department,
    brand_name: payload?.scope?.brand_name ?? null,
    period_start: row.period_start,
    period_end: row.period_end,
  });

  const { data: created, error } = await db
    .from("action_requests")
    .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
    .select("id, title, risk_tier, required_role")
    .single();

  if (error) {
    // An RLS rejection means this role can't file approval requests. Log the
    // detail server-side; return only the generic reason.
    console.error("[metrics/brief/recommend.insert]", error);
    return NextResponse.json(
      { error: "You don't have permission to file an approval request." },
      { status: 403 }
    );
  }
  const ar = created as { id: string; title: string; risk_tier: number; required_role: string };

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: ar.id,
    event: "created",
    actor_id: profile.id, // human-initiated via the brief panel
    actor_role: profile.role,
    detail: { source: "account_review", brief_id: briefId, recommendation_index: index, title: ar.title },
  });

  return NextResponse.json({
    action_request_id: ar.id,
    title: ar.title,
    risk_tier: ar.risk_tier,
    required_role: ar.required_role,
  });
}
