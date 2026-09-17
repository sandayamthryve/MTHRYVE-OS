// lib/windsor/actions.ts — resolves Vesper's generic campaign change into the
// EXACT Windsor write action + params, honouring each connector's verified
// schema. The action ids and unit conventions below were read live from
// Windsor's list_actions (STEP 0 audit), not guessed:
//
//   TikTok  ("tiktok")
//     pause_campaign        { campaign_id }
//     enable_campaign       { campaign_id }
//     set_campaign_budget   { campaign_id, amount }   amount = MAJOR unit integer (₱100 → 100)
//
//   Meta    ("facebook")
//     pause_campaign        { campaign_id }
//     enable_campaign       { campaign_id }
//     set_campaign_budget   { campaign_id, budget_type: "daily"|"lifetime",
//                             amount }                 amount = MINOR unit integer (₱50 → 5000 cents)
//
// Both budget amounts are strictly-positive integers. This module is the one
// place that unit conversion lives, so the executor stays a thin pass-through
// and a maintainer has a single, documented spot to adjust if Windsor's schema
// changes.

import type { AdChange, ProposedBudget, WindsorConnector } from "@/lib/ad-ops/types";

export interface ResolvedWrite {
  action: string;
  params: Record<string, unknown>;
}

// Resolve (connector, change) → Windsor action + params. Throws on an
// unsupported combination or an invalid budget, so a malformed proposal fails
// loudly at draft time rather than reaching the platform.
export function resolveWrite(
  connector: WindsorConnector,
  change: AdChange,
  campaignId: string,
  budget?: ProposedBudget
): ResolvedWrite {
  if (!campaignId) throw new Error("resolveWrite: missing campaign id.");

  if (change === "pause") {
    return { action: "pause_campaign", params: { campaign_id: campaignId } };
  }
  if (change === "enable") {
    return { action: "enable_campaign", params: { campaign_id: campaignId } };
  }

  // set_budget
  if (!budget) throw new Error("resolveWrite: set_budget requires a budget.");
  const major = Number(budget.amount);
  if (!Number.isFinite(major) || major <= 0) {
    throw new Error("resolveWrite: budget amount must be a positive number.");
  }

  if (connector === "tiktok") {
    // TikTok amount is the account-currency MAJOR unit, integer.
    return {
      action: "set_campaign_budget",
      params: { campaign_id: campaignId, amount: Math.round(major) },
    };
  }
  // Meta amount is the account-currency MINOR unit (cents), integer, + type.
  return {
    action: "set_campaign_budget",
    params: {
      campaign_id: campaignId,
      budget_type: budget.kind === "lifetime" ? "lifetime" : "daily",
      amount: Math.round(major * 100),
    },
  };
}

// Whether a (connector, change) pair is one we support end-to-end. Used by the
// executor as a defence-in-depth guard before it ever calls Windsor.
export function isSupportedWrite(connector: WindsorConnector, change: AdChange): boolean {
  if (connector !== "tiktok" && connector !== "facebook") return false;
  return change === "pause" || change === "enable" || change === "set_budget";
}
