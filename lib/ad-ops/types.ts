// lib/ad-ops/types.ts — shared types for Vesper's Ad Ops loop (V3): read ad
// performance via Windsor.ai, propose gated pause/scale/budget changes, and —
// only on approval — execute them back to the platform.
//
// GOVERNING RULE (DECISIONS.md D-005): Vesper READS and PROPOSES; a human
// APPROVES; then the OS EXECUTES. Every spend change is an approval-gated
// action_request. Nothing here moves money — that only happens in the executor
// after a ceo/coo approval.

// The two ad platforms this loop covers, mapped to their Windsor connector ids.
// (Windsor write actions today cover facebook/tiktok/google_ads/linkedin/bing;
// we ship TikTok + Meta, the two connected accounts from the STEP 0 audit.)
export type AdPlatform = "tiktok_ads" | "meta_ads";
export type WindsorConnector = "tiktok" | "facebook";

export const CONNECTOR_BY_PLATFORM: Record<AdPlatform, WindsorConnector> = {
  tiktok_ads: "tiktok",
  meta_ads: "facebook",
};
export const PLATFORM_BY_CONNECTOR: Record<WindsorConnector, AdPlatform> = {
  tiktok: "tiktok_ads",
  facebook: "meta_ads",
};
export const PLATFORM_LABEL: Record<AdPlatform, string> = {
  tiktok_ads: "TikTok Ads",
  meta_ads: "Meta Ads",
};

// One campaign's performance over the read window, normalised across connectors.
// Every metric is nullable — Windsor exposes different fields per connector
// (e.g. TikTok returns conversions, Meta doesn't; neither of the connected
// accounts exposes revenue/ROAS), and a missing metric stays null rather than
// being invented. `roas` is populated only when a revenue-equivalent is present.
export interface AdCampaignPerformance {
  platform: AdPlatform;
  connector: WindsorConnector;
  accountId: string;
  accountName: string | null;
  campaignId: string;
  campaignName: string;
  // brand attribution — set only when the account is mapped to a brand
  brandId: string | null;
  brandName: string | null;
  // metrics (all nullable; currency-valued ones in `currency`)
  spend: number | null;
  clicks: number | null;
  impressions: number | null;
  conversions: number | null;
  revenue: number | null;
  ctr: number | null; // percent, 0..100
  cpc: number | null; // currency per click
  roas: number | null; // revenue / spend, when revenue is known
  currency: string;
}

// The kinds of change Vesper proposes. Reversible, campaign-level, and always
// gated. (enable is the reverse of pause; the scan proposes pause/set_budget,
// enable exists for completeness/reversal.)
export type AdChange = "pause" | "enable" | "set_budget";

export const AD_CHANGE_LABEL: Record<AdChange, string> = {
  pause: "Pause campaign",
  enable: "Enable campaign",
  set_budget: "Set campaign budget",
};

// A proposed budget, in the account currency major unit (e.g. 750 = ₱750/day).
export interface ProposedBudget {
  amount: number; // major unit, e.g. pesos
  currency: string;
  kind: "daily" | "lifetime";
}

// The machine-executable instruction carried on the action_request
// (proposed_action.type === 'ad_action'). The scan resolves the Windsor action
// id + params at draft time so the executor is a thin, honest pass-through; if
// any of it is wrong Windsor rejects it and the executor surfaces the error.
export interface AdActionPayload {
  platform: AdPlatform;
  connector: WindsorConnector;
  accountId: string;
  level: "campaign";
  objectId: string; // campaign_id
  objectName: string;
  change: AdChange;
  budget?: ProposedBudget; // present for set_budget
  // Resolved Windsor write call (verified action ids/params, see windsor/actions.ts)
  windsorAction: string;
  windsorParams: Record<string, unknown>;
  // Performance snapshot at draft time — the "before" side of the audit trail.
  snapshot: {
    spend: number | null;
    conversions: number | null;
    revenue: number | null;
    ctr: number | null;
    cpc: number | null;
    roas: number | null;
    currency: string;
    windowStart: string;
    windowEnd: string;
    status: "active"; // the scan only proposes changes to spending campaigns
  };
}
