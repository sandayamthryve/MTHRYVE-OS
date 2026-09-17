// The words the affiliate team already uses, transcribed from the onboarding
// deck (slide 4, "Key Terms You'll Hear Every Day").
//
// The deck's ask is that the interface speak the same language. The honest part
// of that is knowing which terms name something the app HOLDS and which name
// something an operator DOES outside it — a label on a feature that does not
// exist is worse than no label, because it promises a place to put the thing.
//
// So each term carries `backing`:
//   "stored"   — the app holds this; the label names a real record or field.
//   "guidance" — a real step in the workflow with no artefact store yet. The
//                words belong in instructions, not as a heading over an empty
//                feature.
//
// Definitions are the deck's own, trimmed. Keep them that way: the point is the
// team's vocabulary, not ours.

export type TermBacking = "stored" | "guidance";

export interface Term {
  label: string;
  definition: string;
  backing: TermBacking;
  /** Why it is guidance-only — the gap, recorded rather than papered over. */
  note?: string;
}

export const AFFILIATE_TERMS = {
  creator: {
    label: "Creator / Affiliate",
    definition:
      "A content creator or influencer who promotes and sells a brand's products in exchange for a commission.",
    backing: "stored",
  },
  campaign_brief: {
    label: "Campaign brief",
    definition:
      "A document outlining a campaign's goals, deliverables, timeline, and guidelines for the creator.",
    backing: "guidance",
    note: "A brief generator exists for e-commerce campaigns (components/campaigns/CampaignBrief.tsx) but is not wired into the affiliate campaign page, and nothing stores a brief against a creator.",
  },
  product_deck: {
    label: "Product deck",
    definition:
      "Reference material with product details, key selling points, and visuals shared with creators.",
    backing: "guidance",
    note: "No artefact store. Nothing in the affiliate module holds or attaches a deck, so the term can only appear as part of the onboarding instruction.",
  },
  sample: {
    label: "Sample",
    definition: "The physical product sent to a creator so they can film content or go live with it.",
    backing: "stored",
  },
  campaign_invite: {
    label: "Campaign invite",
    definition:
      "An official invitation sent through the platform for a creator to join a specific brand campaign.",
    backing: "stored",
    note: "outreach_messages.campaign_id (migration 20260917050000) names the op_record the message invites the creator to. An outreach message with no campaign is general outreach, not an invite — the column is what draws that line.",
  },
  creator_community: {
    label: "Creator community",
    definition:
      "The internal group or channel where onboarded creators are managed and communicated with.",
    backing: "stored",
    note: "Advancing a creator to 'onboarded' is this migration — the app records that it happened, not the channel itself.",
  },
  sla: {
    label: "SLA",
    definition:
      "The agreed timeframe for completing a task — e.g., video turnaround time after receiving a sample.",
    backing: "stored",
  },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof AFFILIATE_TERMS;

/**
 * The Onboarding stage, in the deck's words (slide 7).
 *
 * Rendered as instructions on the intake form. Three of the four steps have no
 * field behind them, which is exactly why they are written down: the operator
 * does them in the platform and the chat, and the form is where they will be
 * looking when they need reminding.
 */
export const ONBOARDING_STEPS: readonly string[] = [
  "Walk the creator through the campaign brief.",
  "Share the product deck and campaign guidelines so expectations are clear.",
  "Confirm participation and readiness to proceed.",
  "Migrate the confirmed creator into the creator community.",
];

/** The four stages, in the deck's words (slide 5). */
export const AFFILIATE_WORKFLOW_STAGES: readonly { name: string; summary: string }[] = [
  { name: "Sourcing / Filtering", summary: "Acquire & qualify creators" },
  { name: "Onboarding", summary: "Brief, guidelines & community" },
  { name: "Activation", summary: "Invite, sample & approval" },
  { name: "Monitoring", summary: "Track content against SLA" },
];
