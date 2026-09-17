// Campaign type — the four-way classifier on public.campaigns. One table carries
// every kind of campaign; each area reads the SAME table filtered by type
// (Commerce shows campaign/promotion/mission, Affiliate shows affiliate).
//
// This module is the single source of truth for the allowed set. It mirrors the
// DB CHECK exactly (migration 20260721000000) so the app validates BEFORE insert
// and a bad value is a clean 400-style refusal, never a Postgres CHECK 500.

export const CAMPAIGN_TYPES = ["campaign", "promotion", "mission", "affiliate"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];

export const DEFAULT_CAMPAIGN_TYPE: CampaignType = "campaign";

export const CAMPAIGN_TYPE_LABEL: Record<CampaignType, string> = {
  campaign: "Campaign",
  promotion: "Promotion",
  mission: "Mission",
  affiliate: "Affiliate",
};

// Ring/text tones for the little type chip — same palette vocabulary the status
// chips use elsewhere on the page.
export const CAMPAIGN_TYPE_STYLE: Record<CampaignType, string> = {
  campaign: "text-teal-300 ring-teal-500/40",
  promotion: "text-amber-300 ring-amber-500/40",
  mission: "text-sky-300 ring-sky-500/40",
  affiliate: "text-violet-300 ring-violet-500/40",
};

// The Commerce area owns the non-affiliate kinds; the Affiliate area owns
// 'affiliate'. Used to scope each area's default view to the same one table.
export const COMMERCE_CAMPAIGN_TYPES: readonly CampaignType[] = [
  "campaign",
  "promotion",
  "mission",
];

// Validate an arbitrary string against the allowed set. Callers use this to
// refuse a bad type before it reaches the DB CHECK.
export function isCampaignType(value: unknown): value is CampaignType {
  return typeof value === "string" && (CAMPAIGN_TYPES as readonly string[]).includes(value);
}

// Human label for a possibly-unknown stored value (older/foreign rows). Falls
// back to the raw value rather than inventing a label.
export function campaignTypeLabel(value: string | null | undefined): string {
  if (isCampaignType(value)) return CAMPAIGN_TYPE_LABEL[value];
  return value ?? CAMPAIGN_TYPE_LABEL[DEFAULT_CAMPAIGN_TYPE];
}
