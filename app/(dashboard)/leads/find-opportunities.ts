"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseOpportunityCsv } from "@/lib/opportunities/csv";
import { resolveAutomationUrl } from "@/lib/opportunities/registry";
import {
  callOpportunityEngine,
  type OpportunityCriteria,
  type RankedOpportunity,
} from "@/lib/opportunities/engine";
import { stageHotOpportunities, type StageResult } from "@/lib/opportunities/gateway";

// The "Find Opportunities" panel's server action. It makes the Opportunity Engine
// USABLE BY HAND with no paid lead source: a human pastes/uploads a prospect list,
// this action ranks it through the engine and stages the HOT ones for approval.
//
// Flow: parse candidates → read the engine webhook from the automation_registry
// (never a constant) → POST { criteria, candidates } → normalize the ranked
// results → the gateway stages HOT ones as PENDING action_requests → return the
// results for the panel. Nothing here contacts a prospect.
//
// RLS is the real guard: staging INSERTs an action_request (ceo/coo/
// department_head only), so the action is gated to exactly that set — a
// team_member would be rejected by the policy anyway. The tables are reached
// through the app's cast shim, as elsewhere.

const OPPORTUNITY_ENGINE_KEY = "opportunity_engine";

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

// Why the engine couldn't be called — the panel turns each into a specific,
// fixable message. `not_ready` reasons come straight from the registry resolver.
export type FindOppError =
  | { kind: "no_candidates" }
  | { kind: "not_ready"; reason: "missing" | "disabled" | "no_url" | "placeholder" }
  | { kind: "engine"; message: string };

export interface FindOpportunitiesState {
  ok: boolean;
  results: RankedOpportunity[];
  parsed: number; // candidates parsed from the input
  skippedRows: string[]; // input rows we couldn't parse (e.g. no name)
  stage: StageResult | null; // gateway staging tally (null when nothing ranked HOT / not run)
  error: FindOppError | null;
}

const EMPTY: FindOpportunitiesState = {
  ok: false,
  results: [],
  parsed: 0,
  skippedRows: [],
  stage: null,
  error: null,
};

// Read the candidate list from an uploaded file first, else the pasted textarea.
async function readCandidateText(formData: FormData): Promise<string> {
  const file = formData.get("file");
  if (file && typeof file !== "string" && file.size > 0) {
    return await file.text();
  }
  return String(formData.get("candidates") ?? "");
}

// Build the ranking criteria from the panel's optional fields. Empty inputs stay
// null / false so we never send a fabricated constraint.
function readCriteria(formData: FormData): OpportunityCriteria {
  const focus = String(formData.get("focus_category") ?? "").trim();
  const minRevRaw = String(formData.get("min_monthly_revenue") ?? "").trim();
  const minRev = minRevRaw === "" ? null : Number(minRevRaw.replace(/[₱$€£,\s]/g, ""));
  return {
    focus_category: focus || null,
    min_monthly_revenue: minRev != null && Number.isFinite(minRev) ? minRev : null,
    prioritize: {
      sells_online: formData.get("prioritize_sells_online") === "on",
      has_tiktok_shop: formData.get("prioritize_has_tiktok_shop") === "on",
      gmv_declining: formData.get("prioritize_gmv_declining") === "on",
      runs_ads: formData.get("prioritize_runs_ads") === "on",
    },
  };
}

// Shaped for useFormState. Always resolves to a FindOpportunitiesState — engine /
// config failures are returned, never thrown, so the panel shows a calm message.
export async function findOpportunities(
  _prev: FindOpportunitiesState,
  formData: FormData
): Promise<FindOpportunitiesState> {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  const text = await readCandidateText(formData);
  const { candidates, skipped } = parseOpportunityCsv(text);
  if (candidates.length === 0) {
    return { ...EMPTY, skippedRows: skipped, error: { kind: "no_candidates" } };
  }

  const criteria = readCriteria(formData);

  // The webhook URL is DATA — resolve it from the registry, never a constant.
  const readiness = await resolveAutomationUrl(db, OPPORTUNITY_ENGINE_KEY);
  if (!readiness.ready) {
    return {
      ...EMPTY,
      parsed: candidates.length,
      skippedRows: skipped,
      error: { kind: "not_ready", reason: readiness.reason },
    };
  }

  const call = await callOpportunityEngine(readiness.url, { criteria, candidates });
  if (!call.ok) {
    return {
      ...EMPTY,
      parsed: candidates.length,
      skippedRows: skipped,
      error: { kind: "engine", message: call.error ?? "The engine call failed." },
    };
  }

  // The gateway stages HOT results as pending action_requests for approval.
  const stage = await stageHotOpportunities(db, profile, criteria, call.results);

  revalidatePath("/approvals");
  revalidatePath("/leads");

  return {
    ok: true,
    results: call.results,
    parsed: candidates.length,
    skippedRows: skipped,
    stage,
    error: null,
  };
}
