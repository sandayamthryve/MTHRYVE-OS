// lib/ad-ops/draft.ts — turns one (performance, proposal) pair into an
// action_request draft carrying Vesper's reasoning and a machine-executable
// 'ad_action'. Pure (no DB): the scan producer stamps org_id/created_by and
// inserts it as status='pending'. The OS executes ONLY on a ceo/coo approval.
//
// GOVERNING RULE (DECISIONS.md D-005): Vesper DRAFTS, a human APPROVES, then
// the OS EXECUTES. This module never calls Windsor and never moves money — it
// resolves the exact write call up front (so the executor is a thin
// pass-through) and hands the human a gated request. required_role='coo' → only
// ceo/coo may approve a spend change (task spec).

import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "@/lib/actions/types";
import { resolveWrite } from "@/lib/windsor/actions";
import {
  AD_CHANGE_LABEL,
  PLATFORM_LABEL,
  type AdActionPayload,
  type AdCampaignPerformance,
} from "./types";
import type { AdProposal } from "./rules";

export interface AdOpsDraft {
  source_module: "ad_ops";
  source_ref: {
    platform: string;
    connector: string;
    account_id: string;
    level: "campaign";
    object_id: string;
    change: string;
    window_start: string;
    window_end: string;
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

// The options a human weighs on any ad-spend proposal — least invasive first.
// The same three read sensibly for a pause or a scale; the card's title/problem
// says which one Vesper recommends.
const AD_OPTIONS: ActionOption[] = [
  {
    label: "Approve the proposed change",
    tradeoff:
      "Executes it on the platform via Windsor immediately — the fastest way to stop a loser or scale a winner, but it moves real spend.",
  },
  {
    label: "Adjust first, then approve",
    tradeoff:
      "Pause/scale after a smaller manual tweak (creative, audience, bid) — safer if the metric might be a fixable symptom, but slower to act.",
  },
  {
    label: "Reject / keep watching",
    tradeoff:
      "Leaves the campaign as-is for another window — right when the signal is thin or seasonal, but a true loser keeps burning spend.",
  },
];

function money(n: number | null, currency: string): string {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}

// Build the draft for one campaign + its proposal. `window` provides the human
// window label and the ISO start/end stamped into source_ref for idempotency.
export function buildAdOpsDraft(
  perf: AdCampaignPerformance,
  proposal: AdProposal,
  window: { start: string; end: string; label: string }
): AdOpsDraft {
  const currency = perf.currency;
  const platformLabel = PLATFORM_LABEL[perf.platform];
  const changeLabel = AD_CHANGE_LABEL[proposal.change];
  const brandBit = perf.brandName ? ` · ${perf.brandName}` : "";
  const who = `${platformLabel}${brandBit} — “${perf.campaignName}”`;

  // Resolve the exact Windsor write call now (verified ids/params/units).
  const resolved = resolveWrite(perf.connector, proposal.change, perf.campaignId, proposal.budget);

  const payload: AdActionPayload = {
    platform: perf.platform,
    connector: perf.connector,
    accountId: perf.accountId,
    level: "campaign",
    objectId: perf.campaignId,
    objectName: perf.campaignName,
    change: proposal.change,
    budget: proposal.budget,
    windsorAction: resolved.action,
    windsorParams: resolved.params,
    snapshot: {
      spend: perf.spend,
      conversions: perf.conversions,
      revenue: perf.revenue,
      ctr: perf.ctr,
      cpc: perf.cpc,
      roas: perf.roas,
      currency,
      windowStart: window.start,
      windowEnd: window.end,
      status: "active",
    },
  };

  const evidence: EvidenceFact[] = [
    { label: "Platform", value: platformLabel },
    { label: "Campaign", value: perf.campaignName },
    { label: "Account", value: perf.accountName ?? perf.accountId },
    { label: "Spend", value: money(perf.spend, currency) },
    { label: "ROAS", value: perf.roas != null ? `${perf.roas}×` : "—" },
    { label: "Conversions", value: perf.conversions != null ? String(perf.conversions) : "—" },
    { label: "CTR", value: perf.ctr != null ? `${perf.ctr}%` : "—" },
    { label: "CPC", value: perf.cpc != null ? money(perf.cpc, currency) : "—" },
    { label: "Window", value: window.label },
  ];

  const isPause = proposal.change === "pause";
  const title = `${isPause ? "Pause" : "Scale"} ${platformLabel} campaign${brandBit ? ` (${perf.brandName})` : ""} — ${perf.campaignName}`;
  const problem = `${who}: ${proposal.reason}`;
  const root_cause = isPause
    ? `On ${proposal.signal.toUpperCase()} signal over ${window.label}, this campaign is a loser (${proposal.headline}). Left running it keeps spending against a target it isn't hitting.`
    : `On ${proposal.signal.toUpperCase()} signal over ${window.label}, this campaign is a winner (${proposal.headline}) that is likely budget-constrained — more budget should capture more of the same efficient result.`;

  const recommendation = isPause
    ? `Pause the campaign on ${platformLabel} via Windsor to stop the spend. Reversible — it can be re-enabled once the issue is fixed. Requires ceo/coo approval; nothing is paused automatically.`
    : `Raise the daily budget to ${money(proposal.budget?.amount ?? null, currency)}/day on ${platformLabel} via Windsor (a lift over the recent ~${money(recentDaily(perf.spend), currency)}/day to let a winner scale). Requires ceo/coo approval; no budget moves automatically.`;

  const estimated_impact: EstimatedImpact = isPause
    ? {
        summary: `Stops ~${money(perf.spend, currency)}/window of under-performing spend until the campaign is fixed.`,
        gap_value: perf.spend,
        gap_unit: "spend",
        is_money: true,
      }
    : {
        summary: `Lets an efficient campaign scale — targeting ${money(proposal.budget?.amount ?? null, currency)}/day vs a recent ~${money(recentDaily(perf.spend), currency)}/day.`,
        gap_value: proposal.budget?.amount ?? null,
        gap_unit: "daily budget",
        is_money: true,
      };

  return {
    source_module: "ad_ops",
    source_ref: {
      platform: perf.platform,
      connector: perf.connector,
      account_id: perf.accountId,
      level: "campaign",
      object_id: perf.campaignId,
      change: proposal.change,
      window_start: window.start,
      window_end: window.end,
    },
    title,
    problem,
    root_cause,
    evidence,
    options: AD_OPTIONS,
    recommendation,
    estimated_impact,
    // Confidence is in the DIAGNOSIS, not certainty — a pause on a hard signal
    // (0 conversions / 0 clicks / ROAS floor) is more certain than a scale.
    confidence: isPause ? 0.8 : 0.7,
    // L3 (high risk) — it changes real spend on approval. required_role='coo'
    // so only ceo/coo can approve (task spec).
    risk_tier: 3,
    required_role: "coo",
    proposed_action: {
      type: "ad_action",
      payload: payload as unknown as Record<string, unknown>,
    },
  };
}

// Recent daily spend used only for the impact copy (7-day window default).
function recentDaily(spend: number | null): number | null {
  return spend == null ? null : Math.round(spend / 7);
}
