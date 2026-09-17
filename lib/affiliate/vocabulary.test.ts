import { describe, expect, it } from "vitest";
import { AFFILIATE_TERMS, AFFILIATE_WORKFLOW_STAGES, ONBOARDING_STEPS } from "./vocabulary";

describe("the deck's vocabulary", () => {
  it("keeps the four stages in the deck's order", () => {
    // Slide 5. The order is the workflow, so a reshuffle here is a real change.
    expect(AFFILIATE_WORKFLOW_STAGES.map((stage) => stage.name)).toEqual([
      "Sourcing / Filtering",
      "Onboarding",
      "Activation",
      "Monitoring",
    ]);
  });

  it("covers every term on the key-terms slide", () => {
    // Slide 4. Live Selling is the one term owned by another module, so it is
    // not repeated here.
    expect(Object.keys(AFFILIATE_TERMS).sort()).toEqual(
      ["campaign_brief", "campaign_invite", "creator", "creator_community", "product_deck", "sample", "sla"].sort()
    );
  });

  it("records WHY each guidance-only term has no feature behind it", () => {
    // The whole point of the backing field. A term marked guidance without a
    // note is a gap someone forgot to explain, and the next person to read this
    // will assume the label is just missing rather than the feature.
    const unexplained = Object.entries(AFFILIATE_TERMS)
      .filter(([, term]) => term.backing === "guidance" && !("note" in term && term.note))
      .map(([key]) => key);
    expect(unexplained).toEqual([]);
  });

  it("does not quietly promote a term to stored without evidence", () => {
    // These two still name things the app does not hold: no brief is stored
    // against a creator, and nothing holds a product deck at all. If either
    // flips to "stored", the feature had better exist — this test is the place
    // that argument gets had.
    for (const key of ["campaign_brief", "product_deck"] as const) {
      expect({ key, backing: AFFILIATE_TERMS[key].backing }).toEqual({ key, backing: "guidance" });
    }
    // And these are backed by real records. campaign_invite joined them when
    // outreach_messages gained campaign_id (migration 20260917050000) — before
    // that, no stored message could name the campaign it invited anyone to.
    for (const key of ["creator", "sample", "sla", "creator_community", "campaign_invite"] as const) {
      expect({ key, backing: AFFILIATE_TERMS[key].backing }).toEqual({ key, backing: "stored" });
    }
  });

  it("spells the onboarding steps in the deck's language", () => {
    // Slide 7, condensed. These render as instructions on the intake form, so
    // they must keep the team's words — brief, product deck, community.
    expect(ONBOARDING_STEPS).toHaveLength(4);
    const all = ONBOARDING_STEPS.join(" ").toLowerCase();
    for (const word of ["campaign brief", "product deck", "creator community"]) {
      expect(all).toContain(word);
    }
  });
});
