// lib/briefings/account-review-action.ts — turns ONE Account Review Brief
// recommendation into a PENDING action_request draft.
//
// GOVERNING RULE (D-005): accepting a recommendation does NOT execute anything.
// It stages a pending action_request that a human still has to approve in the
// queue — and even on approval there is no executor for this source_module, so
// nothing is spent and no one is contacted. The row is recommendation-only: it
// carries Tony's reasoning and links back to the brief + target department.

import type { BriefPayload, Recommendation, Priority, Scenario, ScenarioName } from "@/lib/briefings/account-review";
import type { EvidenceFact, RequiredRole } from "@/lib/actions/types";

// Priority → risk tier + who must approve. High-priority strategic calls escalate
// to the COO tier; lower ones can be decided by the owning department head.
const PRIORITY_RISK: Record<Priority, number> = { high: 3, medium: 2, low: 1 };
const PRIORITY_ROLE: Record<Priority, RequiredRole> = {
  high: "coo",
  medium: "department_head",
  low: "department_head",
};

export interface AccountReviewActionDraft {
  source_module: "account_review";
  source_ref: Record<string, unknown>;
  title: string;
  problem: string;
  root_cause: string | null;
  evidence: EvidenceFact[];
  recommendation: string;
  confidence: number | null;
  risk_tier: number;
  required_role: RequiredRole;
  // No proposed_action → the queue treats this as recommendation-only; approval
  // records the decision but has nothing to execute.
}

export function buildRecommendationDraft(args: {
  brief_id: string;
  brief: BriefPayload;
  recommendation: Recommendation;
  index: number;
  department: string;
  brand_name: string | null;
  period_start: string;
  period_end: string;
}): AccountReviewActionDraft {
  const { brief_id, brief, recommendation, index, department, brand_name, period_start, period_end } = args;

  const evidence: EvidenceFact[] = [
    { label: "From brief", value: `${department}${brand_name ? ` · ${brand_name}` : ""}` },
    { label: "Period", value: `${period_start} → ${period_end}` },
    { label: "Priority", value: recommendation.priority },
    { label: "Target department", value: recommendation.target_department || department },
  ];
  if (brief.meta.grounded && brief.meta.model) {
    evidence.push({ label: "Grounded on", value: `${brief.meta.metrics_with_data}/${brief.meta.metrics_total} real metrics` });
  }

  return {
    source_module: "account_review",
    source_ref: {
      brief_id,
      recommendation_index: index,
      department,
      target_department: recommendation.target_department || department,
      period_start,
      period_end,
    },
    title: recommendation.action,
    problem:
      recommendation.rationale ||
      `A recommendation from the ${department} Account Review Brief (${period_start}–${period_end}).`,
    root_cause: brief.meta.grounded ? null : brief.meta.note,
    evidence,
    recommendation: `Approve to accept this recommendation for ${recommendation.target_department || department}. This is advisory only — approval records the decision and opens no automatic action, spend, or outbound contact.`,
    // Model-authored briefs don't emit a per-recommendation confidence; leave
    // null rather than inventing one.
    confidence: null,
    risk_tier: PRIORITY_RISK[recommendation.priority],
    required_role: PRIORITY_ROLE[recommendation.priority],
  };
}

// ── Scenario → pending action_request (AI Brief 2.0, PART B) ───────────────────
// "Send to approval" on a scenario stages a pending, recommendation-only
// action_request: a decision to PLAN for that scenario. Like the recommendation
// draft, it carries no proposed_action, so approval records the decision and
// nothing executes. Planning for the downside carries more weight than the
// upside, so worst > base > best on the risk tier (which the policy consult in
// the route reads to set escalation).
const SCENARIO_RISK: Record<ScenarioName, number> = { best: 1, base: 2, worst: 3 };
const SCENARIO_ROLE: Record<ScenarioName, RequiredRole> = {
  best: "department_head",
  base: "department_head",
  worst: "coo",
};
const SCENARIO_TITLE: Record<ScenarioName, string> = {
  best: "Plan to capture the best-case scenario",
  base: "Plan around the base-case scenario",
  worst: "Prepare a response to the worst-case scenario",
};

export function buildScenarioDraft(args: {
  brief_id: string;
  brief: BriefPayload;
  scenario: Scenario;
  index: number;
  department: string;
  brand_name: string | null;
  period_start: string;
  period_end: string;
}): AccountReviewActionDraft {
  const { brief_id, brief, scenario, index, department, brand_name, period_start, period_end } = args;
  const meta = brief.scenario_meta;

  const evidence: EvidenceFact[] = [
    { label: "From brief", value: `${department}${brand_name ? ` · ${brand_name}` : ""}` },
    { label: "Period", value: `${period_start} → ${period_end}` },
    { label: "Scenario", value: `${scenario.name.toUpperCase()} case` },
    { label: "Confidence", value: `${Math.round(scenario.confidence * 100)}%${meta?.low_data ? " · low-data" : ""}` },
  ];
  if (scenario.drivers.length) {
    evidence.push({ label: "Drivers", value: scenario.drivers.join(", ") });
  }
  if (meta?.grounded && meta.model) {
    evidence.push({ label: "Projected on", value: `${meta.scored_metrics} judged metric(s) · ${meta.model}` });
  }

  return {
    source_module: "account_review",
    source_ref: {
      kind: "scenario",
      brief_id,
      scenario_index: index,
      scenario_name: scenario.name,
      department,
      target_department: department,
      period_start,
      period_end,
    },
    title: SCENARIO_TITLE[scenario.name],
    problem: `${scenario.premise} Projected outcome: ${scenario.projected_outcome}`,
    // The premise IS the assumption set; when the block is a low-data/fallback
    // one, surface that as the honest root cause rather than a clean null.
    root_cause: meta?.grounded ? null : meta?.note ?? null,
    evidence,
    recommendation: `Approve to log a decision to plan for the ${scenario.name}-case scenario for ${department}. Advisory only — approval records the decision and opens no automatic action, spend, or outbound contact.`,
    confidence: scenario.confidence,
    risk_tier: SCENARIO_RISK[scenario.name],
    required_role: SCENARIO_ROLE[scenario.name],
  };
}
