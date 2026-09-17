import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth/session";
import { parseJsonBody, serverError } from "@/lib/security/api";
import { writeActionAudit } from "@/lib/actions/audit";
import { checkPolicy } from "@/lib/governance/policy";
import { buildScenarioDraft } from "@/lib/briefings/account-review-action";
import type { BriefPayload } from "@/lib/briefings/account-review";

const ScenarioSchema = z.object({
  brief_id: z.string().max(200).optional(),
  scenario_index: z.union([z.number(), z.string().max(16)]).optional(),
});

// POST /api/metrics/brief/scenario — "Send to approval" for ONE scenario
// (AI Brief 2.0, PART B).
//
// Staging only: this creates a PENDING action_request recording a decision to
// PLAN for the chosen scenario. It carries the scenario's premise, drivers, and
// confidence, and links back to the brief. Before staging, it CONSULTS the
// Policy Registry (checkPolicy 'ai_recommend' — the recommendations-carry-
// confidence rule) so a low-confidence projection is escalated per the org's
// governance rules, and the consult is written to the audit trail. There is no
// executor for source_module 'account_review', so even on human approval nothing
// runs, no money moves, and no one is contacted (D-005). The scenario is read
// from the PERSISTED brief (by index), never from the request body, so the
// client can't smuggle in a projection the brief never made.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

export async function POST(req: NextRequest) {
  const profile = await getSessionProfile();
  if (!profile) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = await parseJsonBody(req, ScenarioSchema, "metrics/brief/scenario");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const briefId = (body.brief_id ?? "").toString().trim();
  const index = Number(body.scenario_index);
  if (!briefId || !Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "brief_id and scenario_index are required" }, { status: 400 });
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Load the persisted brief (RLS scopes to the caller's org).
  const { data: briefRow, error: briefErr } = await db
    .from("account_review_briefs")
    .select("id, department, brand_id, period_start, period_end, payload")
    .eq("id", briefId)
    .maybeSingle();
  if (briefErr) return serverError("metrics/brief/scenario.load", briefErr, 500, "Could not load the brief.");
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
  const scenario = payload?.scenarios?.[index];
  if (!scenario) return NextResponse.json({ error: "scenario not found on this brief" }, { status: 404 });

  // Don't stack a duplicate for the same brief + scenario.
  const { data: existing } = await db
    .from("action_requests")
    .select("id, source_ref, status")
    .eq("source_module", "account_review")
    .in("status", ["pending", "approved"]);
  const dup = ((existing ?? []) as Array<{ id: string; source_ref: Record<string, unknown> | null }>).find(
    (r) =>
      r.source_ref?.kind === "scenario" &&
      r.source_ref?.brief_id === briefId &&
      Number(r.source_ref?.scenario_index) === index
  );
  if (dup) {
    return NextResponse.json({ action_request_id: dup.id, already: true });
  }

  const draft = buildScenarioDraft({
    brief_id: row.id,
    brief: payload,
    scenario,
    index,
    department: row.department,
    brand_name: payload?.scope?.brand_name ?? null,
    period_start: row.period_start,
    period_end: row.period_end,
  });

  // Consult the Policy Registry BEFORE staging. The 'ai_recommend' rule carries
  // the confidence floor; a scenario below it is flagged needs_approval (which is
  // exactly where it's headed) and the consult is recorded to the audit trail.
  // This never blocks staging — the request is born pending regardless — it reads
  // the governing rule and lets a low-confidence projection escalate its role.
  const gate = await checkPolicy("ai_recommend", {
    orgId: profile.org_id,
    db,
    actorId: profile.id,
    actorRole: profile.role,
    confidence: scenario.confidence,
    detail: { source: "account_review_scenario", brief_id: briefId, scenario_index: index, scenario_name: scenario.name },
  });
  // A projection the policy wants escalated must be decided at the higher tier.
  const required_role = gate.decision === "needs_approval" ? "coo" : draft.required_role;

  const { data: created, error } = await db
    .from("action_requests")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      status: "pending",
      ...draft,
      required_role,
    })
    .select("id, title, risk_tier, required_role")
    .single();

  if (error) {
    // An RLS rejection means this role can't file approval requests. Log the
    // detail server-side; return only the generic reason.
    console.error("[metrics/brief/scenario.insert]", error);
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
    detail: {
      source: "account_review_scenario",
      brief_id: briefId,
      scenario_index: index,
      scenario_name: scenario.name,
      title: ar.title,
      policy_decision: gate.decision,
      policy_key: gate.policyKey,
    },
  });

  return NextResponse.json({
    action_request_id: ar.id,
    title: ar.title,
    risk_tier: ar.risk_tier,
    required_role: ar.required_role,
    policy_decision: gate.decision,
    policy_reason: gate.reason,
  });
}
