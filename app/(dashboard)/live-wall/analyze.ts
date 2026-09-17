"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import { readCompartmentScope } from "@/lib/cognition/scope";
import { runCognitionPlan, planToDraft, isThinScope } from "@/lib/cognition/plan";
import { logCognitionUsage } from "@/lib/cognition/usage";
import { LIVE_COMPARTMENT_CODE } from "@/lib/live-wall/constants";

// Tony Live-Coach — the "Analyze" button on a live tile.
//
// It runs the EXISTING Cognition Loop over the Live compartment (T4 · LIVE &
// Video): read that compartment's real metric_entries (honest "—" where a metric
// has no entry), have Tony emit ONE strict-JSON 3-possibility brief that
// pinpoints the live's bottleneck, and file it into the SAME approval spine as a
// pending action_request — this time tagged source_module='live_coach' and pinned
// to the session that triggered it.
//
// GUARDRAILS honoured verbatim:
//   • Reuses lib/cognition + action_requests — no parallel approver, no new table.
//   • proposed_action stays NULL: the brief is recommendation-only, so on approval
//     the existing decide path rests it at 'approved' and NOTHING auto-executes.
//   • The Claude call is logged to ai_usage_log with feature='live_coach'.
//   • RLS is the real gate: action_requests INSERT requires ceo/coo/department_head,
//     so this action is gated to that set and stamps org_id from the profile.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

interface SessionRow {
  id: string;
  brand_id: string | null;
  title: string | null;
  platform: string;
}

export interface LiveCoachResult {
  ok: boolean;
  created: number; // 1 when a brief was filed, else 0
  thin: boolean; // the Live compartment had no real entries — nothing to reason over
  grounded: number;
  total: number;
  requestId: string | null;
  error?: string;
}

export async function analyzeLiveSession(sessionId: string): Promise<LiveCoachResult> {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  const id = (sessionId ?? "").trim();
  if (!id) {
    return { ok: false, created: 0, thin: false, grounded: 0, total: 0, requestId: null, error: "No session specified." };
  }

  // Read the session for the brief's pin (title/brand/platform). RLS scopes it to
  // the org; a missing row means it's not ours to analyze.
  const { data: sessionData } = await db
    .from("live_sessions")
    .select("id, brand_id, title, platform")
    .eq("id", id)
    .single();
  const session = sessionData as SessionRow | null;
  if (!session) {
    return { ok: false, created: 0, thin: false, grounded: 0, total: 0, requestId: null, error: "That live session was not found." };
  }

  // Ground on the Live compartment — real rows only, honest "—" for empties.
  const scope = await readCompartmentScope(db, [LIVE_COMPARTMENT_CODE]);
  const base = { grounded: scope.grounded, total: scope.readings.length };

  // Too thin to plan → no spend, no invented brief.
  if (isThinScope(scope)) {
    return { ok: true, created: 0, thin: true, requestId: null, ...base };
  }

  // ONE Claude call at the caller-role's default tier (reuses the model ladder:
  // ceo/coo → Opus, department_head → Sonnet).
  const model = TIER_MODEL[defaultTierFor(profile.role)];
  let result;
  try {
    result = await runCognitionPlan(scope, model);
  } catch (e) {
    return {
      ok: false,
      created: 0,
      thin: false,
      requestId: null,
      ...base,
      error: e instanceof Error ? e.message : "Live-coach analysis failed.",
    };
  }

  // Log the call regardless of parse outcome — it cost money. feature='live_coach'.
  await logCognitionUsage(db, {
    orgId: profile.org_id,
    userId: profile.id,
    model: result.model,
    usage: result.usage,
    feature: "live_coach",
  });

  if (!result.plan) {
    return {
      ok: false,
      created: 0,
      thin: false,
      requestId: null,
      ...base,
      error: "Tony's brief came back unreadable — nothing was filed. Try again.",
    };
  }

  // Map onto action_requests, then re-stamp as a live-coach brief pinned to this
  // session (mirrors lib/council/members.ts memberDraft). proposed_action stays
  // null — recommendation-only, nothing auto-executes.
  const generic = planToDraft(result.plan, scope);
  const sessionLabel = session.title?.trim() || "Untitled live";
  const draft = {
    ...generic,
    source_module: "live_coach" as const,
    source_ref: {
      session_id: session.id,
      brand_id: session.brand_id,
      platform: session.platform,
      compartment: LIVE_COMPARTMENT_CODE,
      codes: scope.codes,
    },
    title: `Live-Coach · ${sessionLabel} — bottleneck brief (${scope.grounded}/${scope.readings.length} metrics grounded)`,
  };

  const { data: inserted, error } = await db
    .from("action_requests")
    .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
    .select("id")
    .single();

  if (error || !(inserted as { id?: string } | null)?.id) {
    return {
      ok: false,
      created: 0,
      thin: false,
      requestId: null,
      ...base,
      error: error?.message ?? "Could not file the brief into the approval queue.",
    };
  }
  const requestId = (inserted as { id: string }).id;

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: requestId,
    event: "created",
    actor_id: null,
    actor_role: "system",
    detail: {
      source: "live_coach",
      session_id: session.id,
      compartment: LIVE_COMPARTMENT_CODE,
      grounded: scope.grounded,
      total: scope.readings.length,
      model: result.model,
    },
  });

  revalidatePath("/approvals");
  revalidatePath("/live-wall");
  return { ok: true, created: 1, thin: false, requestId, ...base };
}
