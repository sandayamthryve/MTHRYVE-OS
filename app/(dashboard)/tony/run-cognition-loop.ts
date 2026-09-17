"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import { readCompartmentScope, DEFAULT_COMPARTMENT_CODES } from "@/lib/cognition/scope";
import { runCognitionPlan, planToDraft, isThinScope } from "@/lib/cognition/plan";
import { logCognitionUsage } from "@/lib/cognition/usage";

// The Cognition Loop's SIGNAL PRODUCER, behind the "Run Cognition Loop" button
// on the Tony page. One click:
//   1. READS the chosen compartment scope (default T8 Shop Health + T9 store
//      rating pillars) — real rows only, honest "—" where a metric has no entry.
//   2. PLANS with ONE Claude call (Tony's existing Anthropic client) → a strict
//      JSON 3-possibility brief grounded ONLY in those numbers.
//   3. WRITES ONE action_requests row (status='pending', source_module=
//      'cognition_loop') into the EXISTING approval spine — no new table.
//   4. LOGS the call to ai_usage_log (feature='cognition_loop').
//
// GOVERNING RULE (DECISIONS.md D-005): Tony DRAFTS, a human APPROVES — the brief
// is recommendation-only (proposed_action null), so NOTHING auto-executes. RLS
// is the real guard: action_requests INSERT requires ceo/coo/department_head, so
// this action is gated to that set and every write stamps org_id from the profile.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface CognitionRunResult {
  ok: boolean;
  created: number; // 1 when a brief was drafted, else 0
  thin: boolean; // scope had no real entries — nothing to plan
  grounded: number; // metrics with a real entry
  total: number; // metrics in scope
  scopeLabel: string;
  requestId: string | null;
  error?: string;
}

export async function runCognitionLoop(compartmentCodes?: string[]): Promise<CognitionRunResult> {
  // Leadership set that RLS lets INSERT (and, for coo/ceo, decide) the resulting
  // request. A department_head can also draft, and decide rows required on them.
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  const codes = compartmentCodes?.length ? compartmentCodes : DEFAULT_COMPARTMENT_CODES;
  const scope = await readCompartmentScope(db, codes);

  const base: Omit<CognitionRunResult, "ok" | "created" | "requestId"> = {
    thin: false,
    grounded: scope.grounded,
    total: scope.readings.length,
    scopeLabel: scope.label,
  };

  // Too thin to plan → don't spend a model call inventing a brief. Honest no-op.
  if (isThinScope(scope)) {
    return { ok: true, created: 0, requestId: null, ...base, thin: true };
  }

  // ONE Claude call, at the caller-role's default model tier (reuses the existing
  // model-governance ladder — ceo/coo → Opus, department_head → Sonnet).
  const model = TIER_MODEL[defaultTierFor(profile.role)];
  let result;
  try {
    result = await runCognitionPlan(scope, model);
  } catch (e) {
    return {
      ok: false,
      created: 0,
      requestId: null,
      ...base,
      error: e instanceof Error ? e.message : "Cognition planning failed.",
    };
  }

  // Log the call regardless of whether the JSON parsed — the call cost money.
  await logCognitionUsage(db, {
    orgId: profile.org_id,
    userId: profile.id,
    model: result.model,
    usage: result.usage,
  });

  if (!result.plan) {
    return {
      ok: false,
      created: 0,
      requestId: null,
      ...base,
      error: "Tony's brief came back unreadable — nothing was drafted. Try again.",
    };
  }

  const draft = planToDraft(result.plan, scope);

  const { data: inserted, error } = await db
    .from("action_requests")
    .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
    .select("id")
    .single();

  if (error || !(inserted as { id?: string } | null)?.id) {
    return {
      ok: false,
      created: 0,
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
      source: "run_cognition_loop",
      compartment: draft.source_ref.compartment,
      grounded: scope.grounded,
      total: scope.readings.length,
      model: result.model,
    },
  });

  revalidatePath("/approvals");
  revalidatePath("/tony");
  return { ok: true, created: 1, requestId, ...base };
}
