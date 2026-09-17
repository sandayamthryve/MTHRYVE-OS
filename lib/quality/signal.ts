// lib/quality/signal.ts — the Returns/Quality proactive loop's SIGNAL PRODUCER
// logic (pure, no DB). Given the trailing-window facts a brand or a SKU carries,
// it decides whether the quality picture is bad enough to act on and, when it is,
// DRAFTS one action_request carrying Tony's full reasoning: the problem, the
// evidence, the options a quality owner would weigh, a recommendation, a
// confidence and a machine-executable proposed_action.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES — and the executor only ever opens an INTERNAL task. This
// module pauses no ad, edits no listing, contacts no supplier: it proposes a
// PLAN. A brand/SKU whose numbers are healthy (or too low-volume to trust) is
// simply not drafted — honest signals only, no false alarms.
//
// Every threshold here is a single tunable constant so the sensitivity of the
// loop lives in one place.

import { pctOrDash, int } from "@/lib/metrics/format";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "@/lib/actions/types";

// ── Tunable thresholds ─────────────────────────────────────────────────────────

// A brand's trailing return rate above this fires the headline alarm. Stored as a
// fraction (0.10 = 10%). Return-rate data comes from the settlements-derived
// return signal, not the retired brand_platform_metrics.
export const RETURN_RATE_THRESHOLD = 0.1;

// Fulfillment errors (summed over the window) above this fires the ops alarm. An
// absolute count — tune per the org's order volume.
export const FULFILLMENT_ERRORS_THRESHOLD = 15;

// "Rising materially" vs the prior window means BOTH a real absolute jump (≥ 3
// percentage points) AND a meaningful relative jump (≥ 30%), and only once the
// current rate clears a small floor so a 0.5%→1.5% wobble never trips it.
export const RETURN_RATE_RISE_ABS = 0.03;
export const RETURN_RATE_RISE_REL = 0.3;
export const RETURN_RATE_RISE_FLOOR = 0.05;

// Volume guard: a brand needs at least this many orders (or, failing an orders
// count, this many units) in the window before any rate-based rule is trusted.
// Low-volume brands are skipped — a 1-in-3 return on 3 orders is noise.
export const MIN_BRAND_ORDERS = 20;
export const MIN_BRAND_UNITS = 20;

// A SKU's latest rating below this is a quality flag, but only with meaningful
// volume behind it.
export const PRODUCT_RATING_THRESHOLD = 4.0;
export const MIN_PRODUCT_UNITS = 30;

// An abnormal returns/units ratio for a SKU (returns ≥ 15% of units sold).
export const PRODUCT_RETURN_RATIO_THRESHOLD = 0.15;

// ── Display helpers ─────────────────────────────────────────────────────────────

// A fraction (0..1) → "14.5%"; null → em-dash. One place so every quality figure
// reads identically on the card.
function rrPct(x: number | null | undefined): string {
  return x == null ? "—" : pctOrDash(x * 100, 1);
}

// ── Brand-level signal ───────────────────────────────────────────────────────────

// The trailing facts a brand carries, computed once in the data layer so the view
// and the scan route on identical numbers. Rates are fractions (0..1). A null
// numeric means "not reported" — never a fabricated zero.
export interface BrandQualityFacts {
  brandId: string;
  brandName: string | null;
  returnRate: number | null; // current window
  priorReturnRate: number | null; // prior window (for the rising check)
  returns: number | null; // summed returns this window (null = none reported)
  units: number; // units this window
  orders: number; // orders this window (the volume basis)
  gmv: number; // gmv this window
  fulfillmentErrors: number | null; // summed this window (null = none reported)
}

export type BrandTrigger = "return_rate_high" | "fulfillment_errors_high" | "return_rate_rising";

// Does the brand carry enough volume for a rate-based rule to be trustworthy?
export function brandHasVolume(f: BrandQualityFacts): boolean {
  return f.orders >= MIN_BRAND_ORDERS || f.units >= MIN_BRAND_UNITS;
}

// Which brand rules fire. Returns [] when the brand is healthy or too low-volume.
export function evaluateBrand(f: BrandQualityFacts): BrandTrigger[] {
  const triggers: BrandTrigger[] = [];
  const hasVolume = brandHasVolume(f);

  if (hasVolume && f.returnRate != null && f.returnRate > RETURN_RATE_THRESHOLD) {
    triggers.push("return_rate_high");
  }

  // Fulfillment errors are an absolute count — no volume guard needed (errors are
  // errors), but we still only fire when a real number is reported.
  if (f.fulfillmentErrors != null && f.fulfillmentErrors > FULFILLMENT_ERRORS_THRESHOLD) {
    triggers.push("fulfillment_errors_high");
  }

  // Rising materially vs the prior window. Guarded: needs volume, both rates
  // present, a positive prior base (no divide-by-zero), the current rate above a
  // small floor, and both an absolute and a relative jump.
  if (
    hasVolume &&
    f.returnRate != null &&
    f.priorReturnRate != null &&
    f.priorReturnRate > 0 &&
    f.returnRate >= RETURN_RATE_RISE_FLOOR
  ) {
    const absRise = f.returnRate - f.priorReturnRate;
    const relRise = absRise / f.priorReturnRate;
    if (absRise >= RETURN_RATE_RISE_ABS && relRise >= RETURN_RATE_RISE_REL) {
      triggers.push("return_rate_rising");
    }
  }

  return triggers;
}

// The four options a quality owner weighs (task spec order). None is applied
// automatically — the human picks when they act on the task.
export const QUALITY_OPTIONS: ActionOption[] = [
  {
    label: "Investigate return reasons",
    tradeoff:
      "Roots out WHY (size, defect, expectations) so the fix is targeted — but takes time before anything changes.",
  },
  {
    label: "Pause promotion / ads",
    tradeoff:
      "Stops pouring spend into a leaky funnel immediately — but forfeits sales while the issue is unresolved.",
  },
  {
    label: "Supplier / QA review",
    tradeoff:
      "Fixes a defect at the source and prevents recurrence — but is the slowest lever and leans on the supplier.",
  },
  {
    label: "Fix listing / expectations",
    tradeoff:
      "Cheap and fast — better photos, sizing, copy cut returns driven by mismatch — but won't fix a real defect.",
  },
];

// The drafted shape (minus org_id / created_by — the caller stamps those). iso_week
// is carried in source_ref so the producer stays idempotent (one quality draft per
// brand/SKU per week).
export interface QualityDraft {
  source_module: "quality";
  source_ref: { brand_id: string | null; sku: string | null; kind: "brand" | "product"; iso_week: string };
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

// Confidence in the brand DIAGNOSIS — higher the further over the bar, and for
// each extra corroborating trigger. Bounded [0.6, 0.9]; Tony is never certain.
function brandConfidence(f: BrandQualityFacts, triggers: BrandTrigger[]): number {
  let raw = 0.62;
  if (f.returnRate != null && f.returnRate > RETURN_RATE_THRESHOLD) {
    raw += Math.min(0.2, ((f.returnRate - RETURN_RATE_THRESHOLD) / RETURN_RATE_THRESHOLD) * 0.2);
  }
  raw += Math.max(0, triggers.length - 1) * 0.05;
  return Math.min(0.9, Math.max(0.6, Math.round(raw * 100) / 100));
}

// The short issue phrase carried into the task title / payload.
function brandIssue(f: BrandQualityFacts, triggers: BrandTrigger[]): string {
  const bits: string[] = [];
  if (triggers.includes("return_rate_high") || triggers.includes("return_rate_rising")) {
    bits.push(`return rate ${rrPct(f.returnRate)}`);
  }
  if (triggers.includes("fulfillment_errors_high")) {
    bits.push(`${int(f.fulfillmentErrors ?? 0)} fulfillment errors`);
  }
  return bits.join(", ") || "quality risk";
}

// The recommended first step — leads with the sharpest lever for the triggers.
function brandSuggestedAction(triggers: BrandTrigger[]): string {
  if (triggers.includes("fulfillment_errors_high") && !triggers.includes("return_rate_high")) {
    return "Audit fulfillment/QA to clear the error spike before it drives returns.";
  }
  return "Investigate the return reasons and run a supplier/QA review; fix listing/expectations if the driver is mismatch.";
}

// Build the brand-level draft. Caller guarantees triggers.length > 0.
export function buildBrandQualityDraft(
  f: BrandQualityFacts,
  triggers: BrandTrigger[],
  isoWeek: string
): QualityDraft {
  const brand = f.brandName?.trim() || "Brand";

  // Problem line — assembled from whichever rules fired, in reading order.
  const parts: string[] = [];
  if (triggers.includes("return_rate_high")) {
    const vs = f.priorReturnRate != null ? ` this week vs ${rrPct(f.priorReturnRate)} last` : " this week";
    parts.push(`return rate ${rrPct(f.returnRate)}${vs} (above the ${rrPct(RETURN_RATE_THRESHOLD)} bar)`);
  } else if (triggers.includes("return_rate_rising")) {
    parts.push(`return rate rising to ${rrPct(f.returnRate)} this week from ${rrPct(f.priorReturnRate)} last`);
  }
  if (triggers.includes("fulfillment_errors_high")) {
    parts.push(`${int(f.fulfillmentErrors ?? 0)} fulfillment errors this week (above ${FULFILLMENT_ERRORS_THRESHOLD})`);
  }
  const problem = `${brand}: ${parts.join("; ")}.`;

  const volumeNote = `over ${int(f.orders)} order${f.orders === 1 ? "" : "s"} / ${int(f.units)} unit${
    f.units === 1 ? "" : "s"
  } this week`;
  const root_cause = triggers.includes("return_rate_high") || triggers.includes("return_rate_rising")
    ? `Returns are running ahead of the acceptable bar ${volumeNote} — a signal of a defect, a sizing/expectations mismatch, or a fulfillment problem eroding margin and rating. The driver needs to be isolated before it compounds.`
    : `Fulfillment errors are elevated ${volumeNote} — mis-picks, delays or wrong items that turn into returns and bad reviews if not corrected at the ops/QA layer.`;

  const evidence: EvidenceFact[] = [
    { label: "Return rate", value: rrPct(f.returnRate) },
    { label: "Prior return rate", value: rrPct(f.priorReturnRate) },
    { label: "Returns", value: f.returns != null ? int(f.returns) : "not reported" },
    { label: "Units", value: int(f.units) },
    { label: "Orders", value: int(f.orders) },
    { label: "Fulfillment errors", value: f.fulfillmentErrors != null ? int(f.fulfillmentErrors) : "not reported" },
  ];

  const suggested = brandSuggestedAction(triggers);
  const recommendation = `Open a quality task for the ecom/ops owner — ${suggested} The human decides the actual levers (investigate, pause promotion, supplier/QA review, fix the listing); nothing is paused or edited automatically.`;

  return {
    source_module: "quality",
    source_ref: { brand_id: f.brandId, sku: null, kind: "brand", iso_week: isoWeek },
    title: `Quality issue — ${brand}: ${brandIssue(f, triggers)}`,
    problem,
    root_cause,
    evidence,
    options: QUALITY_OPTIONS,
    recommendation,
    estimated_impact: {
      summary: `Bringing the return rate back under ${rrPct(RETURN_RATE_THRESHOLD)} protects margin and rating on ${brand}'s ${int(
        f.units
      )} weekly units.`,
      gap_value: f.returnRate != null ? Math.round(f.returnRate * 1000) / 10 : null,
      gap_unit: f.returnRate != null ? "% return rate" : null,
      is_money: false,
    },
    confidence: brandConfidence(f, triggers),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "create_quality_task",
      payload: {
        brand_id: f.brandId,
        sku: null,
        issue: brandIssue(f, triggers),
        suggested_action: suggested,
      },
    },
  };
}

// ── Product-level signal ──────────────────────────────────────────────────────────

// The trailing facts a SKU carries (from product_metrics), computed once in the
// data layer. returnRatio is returns/units, guarded (null when units is 0).
export interface ProductQualityFacts {
  brandId: string | null;
  brandName: string | null;
  sku: string;
  productName: string | null;
  productRating: number | null; // latest rating in / near the window
  units: number; // units this window
  returns: number | null; // summed returns this window (null = none reported)
  returnRatio: number | null; // returns / units, guarded
}

export type ProductTrigger = "rating_low" | "returns_abnormal";

// Which SKU rules fire. Returns [] when the SKU is healthy or too low-volume.
export function evaluateProduct(f: ProductQualityFacts): ProductTrigger[] {
  const triggers: ProductTrigger[] = [];
  const hasVolume = f.units >= MIN_PRODUCT_UNITS;
  if (hasVolume && f.productRating != null && f.productRating < PRODUCT_RATING_THRESHOLD) {
    triggers.push("rating_low");
  }
  if (hasVolume && f.returnRatio != null && f.returnRatio > PRODUCT_RETURN_RATIO_THRESHOLD) {
    triggers.push("returns_abnormal");
  }
  return triggers;
}

function productConfidence(f: ProductQualityFacts, triggers: ProductTrigger[]): number {
  let raw = 0.62;
  if (f.productRating != null && f.productRating < PRODUCT_RATING_THRESHOLD) {
    raw += Math.min(0.2, ((PRODUCT_RATING_THRESHOLD - f.productRating) / PRODUCT_RATING_THRESHOLD) * 0.4);
  }
  raw += Math.max(0, triggers.length - 1) * 0.05;
  return Math.min(0.9, Math.max(0.6, Math.round(raw * 100) / 100));
}

function productIssue(f: ProductQualityFacts, triggers: ProductTrigger[]): string {
  const bits: string[] = [];
  if (triggers.includes("rating_low")) bits.push(`rating ${f.productRating?.toFixed(1) ?? "—"} over ${int(f.units)} units`);
  if (triggers.includes("returns_abnormal")) bits.push(`returns ${rrPct(f.returnRatio)} of ${int(f.units)} units`);
  return bits.join(", ") || "quality risk";
}

function productSuggestedAction(triggers: ProductTrigger[]): string {
  if (triggers.includes("returns_abnormal") && !triggers.includes("rating_low")) {
    return "Investigate return reasons on this SKU and run a supplier/QA review; pause promotion if it's a defect.";
  }
  if (triggers.includes("rating_low") && !triggers.includes("returns_abnormal")) {
    return "Read the low-star reviews to fix listing/expectations, and pause ads on the SKU until the rating recovers.";
  }
  return "Investigate return reasons, pause promotion on the SKU, and run a supplier/QA review while fixing the listing.";
}

// Build the product-level draft. Caller guarantees triggers.length > 0.
export function buildProductQualityDraft(
  f: ProductQualityFacts,
  triggers: ProductTrigger[],
  isoWeek: string
): QualityDraft {
  const name = f.productName?.trim() || f.sku;
  const label = f.brandName ? `${name} (${f.sku}) · ${f.brandName}` : `${name} (${f.sku})`;

  const parts: string[] = [];
  if (triggers.includes("rating_low")) {
    parts.push(`rating ${f.productRating?.toFixed(1) ?? "—"} over ${int(f.units)} units (below ${PRODUCT_RATING_THRESHOLD.toFixed(1)})`);
  }
  if (triggers.includes("returns_abnormal")) {
    parts.push(`returns ${rrPct(f.returnRatio)} of ${int(f.units)} units (abnormal)`);
  }
  const problem = `SKU ${label}: ${parts.join("; ")}.`;

  const root_cause = triggers.includes("rating_low")
    ? `A sub-${PRODUCT_RATING_THRESHOLD.toFixed(1)} rating on ${int(
        f.units
      )} units means unhappy buyers — usually a defect, a sizing/expectations gap, or a listing that oversells. Left alone it depresses conversion and ad efficiency on the SKU.`
    : `Returns are an abnormal share of units sold on this SKU — capital and margin lost to sending stock out and back. The return driver needs isolating (defect vs mismatch) before scaling spend on it.`;

  const evidence: EvidenceFact[] = [
    { label: "Rating", value: f.productRating != null ? f.productRating.toFixed(1) : "not reported" },
    { label: "Units", value: int(f.units) },
    { label: "Returns", value: f.returns != null ? int(f.returns) : "not reported" },
    { label: "Returns / units", value: rrPct(f.returnRatio) },
  ];

  const suggested = productSuggestedAction(triggers);
  const recommendation = `Open a quality task for the ecom/ops owner — ${suggested} The human decides the levers (investigate, pause promotion/ads on the SKU, supplier/QA review, fix the listing); nothing is paused or edited automatically.`;

  return {
    source_module: "quality",
    source_ref: { brand_id: f.brandId, sku: f.sku, kind: "product", iso_week: isoWeek },
    title: `Quality issue — ${name} (${f.sku})${f.brandName ? ` · ${f.brandName}` : ""}: ${productIssue(f, triggers)}`,
    problem,
    root_cause,
    evidence,
    options: QUALITY_OPTIONS,
    recommendation,
    estimated_impact: {
      summary: triggers.includes("returns_abnormal")
        ? `Cutting this SKU's return share protects the margin on its ${int(f.units)} weekly units.`
        : `Recovering the rating restores conversion and ad efficiency on ${name}.`,
      gap_value: triggers.includes("returns_abnormal") && f.returnRatio != null
        ? Math.round(f.returnRatio * 1000) / 10
        : null,
      gap_unit: triggers.includes("returns_abnormal") && f.returnRatio != null ? "% returns" : null,
      is_money: false,
    },
    confidence: productConfidence(f, triggers),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "create_quality_task",
      payload: {
        brand_id: f.brandId,
        sku: f.sku,
        issue: productIssue(f, triggers),
        suggested_action: suggested,
      },
    },
  };
}
