// lib/actions/standards.ts — the affiliate performance-standard loop's SIGNAL
// PRODUCER logic (pure, no DB). For a creator with an ACTIVE affiliate deal who
// is missing the weekly standard, it drafts ONE action_request carrying Tony's
// reasoning: the posting-cadence and/or GMV gap, the options weighed, and a
// proposed create_standards_task the OS runs only on human approval.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES. This module never pauses a deal, never recovers product, and
// never fabricates — every number comes from the computed KPI (which itself only
// grades real inputs). Nothing external happens here or downstream.
//
// FLAG TRIGGER (task spec): a creator is below standard when
//   post_rate < required_post_rate_pct (the 95% bar)  OR  attributed_gmv < min_gmv.
// That is exactly kpi.meetsPostRate === false || kpi.meetsGmv === false — the
// per-part booleans are true/false only when the input exists to grade them, so
// a missing input never trips a false flag.

import { peso, int } from "@/lib/metrics/format";
import type { IsoWeekWindow } from "@/lib/metrics/windows";
import type { StandardCreator, StandardKpi } from "@/lib/affiliate/standards";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "./types";

// True when the creator is missing the weekly standard on cadence and/or GMV.
// Caller guarantees the creator has an active deal and a weekly commitment set.
export function isBelowStandard(kpi: StandardKpi): boolean {
  return kpi.meetsPostRate === false || kpi.meetsGmv === false;
}

// The four options Tony weighs on a standards miss (task spec order). Least
// invasive first; the deal is never paused without a human choosing to.
const STANDARDS_OPTIONS: ActionOption[] = [
  {
    label: "Nudge / follow-up with the creator",
    tradeoff:
      "Re-sets expectations on cadence and re-engages them — the lightest touch, but relies on them responding.",
  },
  {
    label: "Pause the deal",
    tradeoff:
      "Stops attributing spend to an under-delivering partner — but it's a relationship call, and pausing a KOL mid-window can sour it.",
  },
  {
    label: "Recover product",
    tradeoff:
      "Pulls seeded product back when there's no delivery to justify it — appropriate for a persistent miss, heavy-handed for a one-week dip.",
  },
  {
    label: "Re-tier the creator",
    tradeoff:
      "Moves them to a band that matches their real reach/GMV so the standard is fair — but changes their targets and commercials.",
  },
];

// The single suggested next action carried into the task title + payload. Least
// invasive by default (a nudge); GMV-only misses lean to a product/attribution
// review. The human still chooses from all four options on the card.
export function suggestedAction(kpi: StandardKpi): string {
  const cadenceMiss = kpi.meetsPostRate === false;
  const gmvMiss = kpi.meetsGmv === false;
  if (cadenceMiss && gmvMiss) return "Nudge / follow-up, then review the deal if it persists";
  if (gmvMiss && !cadenceMiss) return "Recover product / review attribution";
  return "Nudge / follow-up on posting cadence";
}

// Confidence in the DIAGNOSIS (that the creator is genuinely below standard) —
// higher the further under the bar / floor they sit. Bounded [0.6, 0.95]; Tony
// is never presented as certain.
function diagnosisConfidence(kpi: StandardKpi): number {
  let raw = 0.6;
  if (kpi.meetsPostRate === false && kpi.postRatePct != null) {
    raw += Math.min(0.25, (kpi.requiredPostRatePct - kpi.postRatePct) / 200);
  }
  if (kpi.meetsGmv === false && kpi.gmvGap != null && kpi.minGmv && kpi.minGmv > 0) {
    raw += Math.min(0.25, (kpi.gmvGap / kpi.minGmv) * 0.25);
  }
  return Math.min(0.95, Math.max(0.6, Math.round(raw * 100) / 100));
}

// The drafted payload, minus org_id (the caller stamps that from the profile so
// the RLS with_check passes). This is Tony's reasoning as it lands in the queue.
export interface StandardsDraft {
  source_module: "affiliate";
  source_ref: {
    creator_id: string;
    deal_id: string | null;
    owner_id: string | null;
    iso_week: string;
  };
  title: string;
  problem: string;
  root_cause: string;
  evidence: EvidenceFact[];
  options: ActionOption[];
  recommendation: string;
  estimated_impact: EstimatedImpact;
  confidence: number;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: ProposedAction;
}

const tierLabel = (t: string | null) => (t ? t : "Untiered");

// Build the draft for one below-standard creator. Caller guarantees
// isBelowStandard(kpi) and that the creator has an active deal + weekly commitment.
export function buildStandardsDraft(
  creator: StandardCreator,
  dealId: string | null,
  kpi: StandardKpi,
  week: IsoWeekWindow
): StandardsDraft {
  const who = creator.handle ? `${creator.name} (${creator.handle})` : creator.name;
  const tier = tierLabel(kpi.tierName);
  const rate = kpi.postRatePct;
  const cadenceMiss = kpi.meetsPostRate === false;
  const gmvMiss = kpi.meetsGmv === false;

  // Problem lines — cadence and/or GMV, each stated only when it's the miss.
  const parts: string[] = [];
  if (cadenceMiss) {
    parts.push(
      `${kpi.delivered}/${kpi.committed} posts = ${rate ?? 0}% this week (bar ${kpi.requiredPostRatePct}%)`
    );
  }
  if (gmvMiss && kpi.attributedGmv != null && kpi.minGmv != null) {
    parts.push(
      `attributed GMV ${peso(kpi.attributedGmv)} vs ${peso(kpi.minGmv)} floor (${kpi.gmvPeriod})`
    );
  }
  const problem = `${tier} KOL ${who}: ${parts.join("; ")}.`;

  const root_cause = cadenceMiss
    ? `Posting cadence is under the ${kpi.requiredPostRatePct}% weekly bar for the ${tier} tier — the partner is not delivering the committed volume this ISO week (${week.label}).`
    : `Attributed GMV is below the ${tier} tier's ${kpi.gmvPeriod} floor — the partnership isn't converting to the committed revenue.`;

  const evidence: EvidenceFact[] = [
    { label: "Tier", value: tier },
    { label: "Delivered", value: kpi.committed != null ? `${kpi.delivered}/${kpi.committed}` : String(kpi.delivered) },
    { label: "Post rate", value: rate != null ? `${rate}%` : "—" },
    { label: "Attributed GMV", value: kpi.attributedGmv != null ? peso(kpi.attributedGmv) : "—" },
    { label: "GMV floor", value: kpi.minGmv != null ? peso(kpi.minGmv) : "—" },
    { label: "Followers", value: kpi.followerCount != null ? int(kpi.followerCount) : "—" },
    { label: "ISO week", value: week.isoWeek },
  ];

  const suggestion = suggestedAction(kpi);
  const recommendation = `Create a standards task for the affiliate lead to ${suggestion.toLowerCase()} — human decides whether to pause, recover product, or re-tier. Nothing is paused automatically.`;

  const impactSummary = cadenceMiss
    ? `Gets ${who} back to the ${kpi.requiredPostRatePct}% posting bar before the miss compounds.`
    : `Closes the GMV shortfall on ${who} or resets the standard to match their real reach.`;

  return {
    source_module: "affiliate",
    source_ref: {
      creator_id: creator.id,
      deal_id: dealId,
      owner_id: creator.owner_id,
      iso_week: week.isoWeek,
    },
    title: `${tier} KOL ${creator.name} below standard`,
    problem,
    root_cause,
    evidence,
    options: STANDARDS_OPTIONS,
    recommendation,
    estimated_impact: {
      summary: impactSummary,
      gap_value: gmvMiss ? kpi.gmvGap : null,
      gap_unit: gmvMiss ? "GMV" : null,
      is_money: gmvMiss,
    },
    confidence: diagnosisConfidence(kpi),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "create_standards_task",
      payload: {
        creator_id: creator.id,
        deal_id: dealId,
        tier,
        post_rate_pct: rate,
        gmv_gap: gmvMiss ? kpi.gmvGap : null,
        suggested_action: suggestion,
      },
    },
  };
}
