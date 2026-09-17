// lib/warehouse/actions.ts — the Intelligent Warehouse's SIGNAL PRODUCER logic
// (pure, no DB). It ROUTES each product to exactly one action and DRAFTS the
// matching action_request carrying Tony's reasoning:
//   • REPLENISH — a Fast/Healthy product running low → propose a stock-up task.
//   • PUSH-TO-SELL — dead / aging / near-expiry / high-value stagnant stock →
//     propose a demand-side task with tactics to weigh.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES. Nothing here orders stock, cuts a price, or seeds a creator —
// every draft is a proposal a human approves, and only then does the OS open an
// INTERNAL task. Nothing external, ever.
//
// Every number comes from the shared velocity engine (lib/warehouse/velocity),
// so the class/cover a card shows and the class/cover a drafted action cites are
// the same computation — never duplicated math.

import { peso, int } from "@/lib/metrics/format";
import {
  MOVEMENT_LABEL,
  REPLENISH_COVER_DAYS,
  type MovementClass,
  type Velocity,
} from "./velocity";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "@/lib/actions/types";

// The product-master fields the router/drafts read (a subset of the products row).
export interface RoutableProduct {
  brand_id: string | null;
  sku: string;
  product_name: string | null;
  is_perishable: boolean;
  is_high_value: boolean;
  is_fragile: boolean;
  unit_value: number | null;
  reorder_point: number | null;
  target_cover_days: number; // defaults to 30 at the DB
}

// The aging facts the router/drafts read (computed once in the data layer).
export interface AgingFacts {
  daysInStock: number | null; // today − stocked_at
  daysToExpiry: number | null; // expiry_date − today
  valueAtRisk: number | null; // stock × unit_value
}

export type WarehouseRoute = "replenish" | "push" | null;

// ── Routing ───────────────────────────────────────────────────────────────────
//
// Each product goes to at most ONE path (never both). The triggers:
//
//   REPLENISH  Fast/Healthy AND (stock ≤ reorder_point when set,
//              else days_of_cover < 7)
//   PUSH       Non-moving with stock; OR Slow AND days_in_stock > 90;
//              OR perishable AND days_to_expiry < 30 (urgent);
//              OR high-value AND Non-moving.
//
// PRECEDENCE: a push trigger wins over a replenish trigger. The only overlap is
// a Fast/Healthy product that is ALSO a perishable within 30 days of expiry —
// there we sell the near-expiry stock down (push) rather than order more of
// something about to expire (replenish).

export function isPerishableUrgent(product: RoutableProduct, aging: AgingFacts): boolean {
  return (
    product.is_perishable && aging.daysToExpiry != null && aging.daysToExpiry < 30
  );
}

// A push-to-sell case is "urgent" when the risk is time-bound: a perishable
// nearing expiry, or high-value stock that has gone dead. These sort to the top
// and shorten the executed task's due date.
export function isPushUrgent(product: RoutableProduct, velocity: Velocity, aging: AgingFacts): boolean {
  return (
    isPerishableUrgent(product, aging) ||
    (product.is_high_value && velocity.movement === "nonmoving")
  );
}

export function needsPush(product: RoutableProduct, velocity: Velocity, aging: AgingFacts): boolean {
  const stock = velocity.stock ?? 0;
  const nonMovingWithStock = velocity.movement === "nonmoving" && stock > 0;
  const slowAndAged =
    velocity.movement === "slow" && aging.daysInStock != null && aging.daysInStock > 90;
  const highValueDead = product.is_high_value && velocity.movement === "nonmoving";
  return nonMovingWithStock || slowAndAged || isPerishableUrgent(product, aging) || highValueDead;
}

export function needsReplenish(product: RoutableProduct, velocity: Velocity): boolean {
  if (velocity.movement !== "fast" && velocity.movement !== "healthy") return false;
  // reorder_point takes priority when the human has set one; otherwise fall back
  // to a days-of-cover floor. Either needs a real reading to fire.
  if (product.reorder_point != null) {
    return velocity.stock != null && velocity.stock <= product.reorder_point;
  }
  return velocity.daysOfCover != null && velocity.daysOfCover < REPLENISH_COVER_DAYS;
}

// The single route decision, push-first (see PRECEDENCE above).
export function routeProduct(
  product: RoutableProduct,
  velocity: Velocity,
  aging: AgingFacts
): WarehouseRoute {
  if (needsPush(product, velocity, aging)) return "push";
  if (needsReplenish(product, velocity)) return "replenish";
  return null;
}

// suggested_qty = ceil(avg_daily_units × target_cover_days − stock), floored at 0.
export function suggestedReplenishQty(product: RoutableProduct, velocity: Velocity): number {
  const target = product.target_cover_days > 0 ? product.target_cover_days : 30;
  const stock = velocity.stock ?? 0;
  const gap = velocity.avgDailyUnits * target - stock;
  return Math.max(0, Math.ceil(gap));
}

// ── Push-to-sell tactics ──────────────────────────────────────────────────────
// The five options a human weighs on a push card (task spec order). None is
// applied automatically — the human picks when they act on the task.

export const PUSH_TACTICS: ActionOption[] = [
  {
    label: "Flash discount",
    tradeoff: "Moves units fastest and clears near-expiry risk — but cuts margin on every unit.",
  },
  {
    label: "Feature in next live",
    tradeoff: "Free reach to a warm audience — but competes for limited live slots and prep time.",
  },
  {
    label: "Creative push",
    tradeoff: "A fresh angle can re-ignite demand without discounting — but takes longer to land.",
  },
  {
    label: "Bundle",
    tradeoff: "Lifts basket size and clears slow stock with a fast mover — but discounts the pair.",
  },
  {
    label: "Affiliate seeding",
    tradeoff: "Creator-driven demand at scale — but carries seeding cost and a lead time before lift.",
  },
];

// The single tactic carried into the task title/payload. Chosen by the dominant
// risk; the human still picks from all five on the card.
export function suggestedTactic(product: RoutableProduct, velocity: Velocity, aging: AgingFacts): string {
  if (isPerishableUrgent(product, aging)) return "Flash discount";
  if (product.is_high_value && velocity.movement === "nonmoving") return "Feature in next live";
  if (velocity.movement === "slow") return "Bundle";
  return "Creative push";
}

// ── Draft shapes (minus org_id / created_by — the caller stamps those) ─────────

export interface WarehouseDraftBase {
  source_module: "warehouse";
  source_ref: { brand_id: string | null; sku: string };
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

const fmtCover = (c: number | null): string => (c == null ? "—" : `${Math.round(c)}d`);
const fmtDays = (d: number | null): string => (d == null ? "—" : `${d}d`);

function handlingLabels(product: RoutableProduct): string {
  const chips: string[] = [];
  if (product.is_fragile) chips.push("Fragile");
  if (product.is_perishable) chips.push("Perishable");
  if (product.is_high_value) chips.push("High-value");
  return chips.length ? chips.join(", ") : "None";
}

// Confidence in the REPLENISH diagnosis — higher the further under the floor the
// product sits. Bounded [0.6, 0.9]; Tony is never presented as certain.
function replenishConfidence(product: RoutableProduct, velocity: Velocity): number {
  let raw = 0.7;
  if (product.reorder_point != null && velocity.stock != null && product.reorder_point > 0) {
    raw += Math.min(0.2, ((product.reorder_point - velocity.stock) / product.reorder_point) * 0.2);
  } else if (velocity.daysOfCover != null) {
    raw += Math.min(0.2, ((REPLENISH_COVER_DAYS - velocity.daysOfCover) / REPLENISH_COVER_DAYS) * 0.2);
  }
  return Math.min(0.9, Math.max(0.6, Math.round(raw * 100) / 100));
}

// Confidence in the PUSH diagnosis — higher for time-bound / high-value risk.
function pushConfidence(product: RoutableProduct, velocity: Velocity, aging: AgingFacts): number {
  let raw = 0.65;
  if (isPerishableUrgent(product, aging) && aging.daysToExpiry != null) {
    raw += Math.min(0.25, ((30 - aging.daysToExpiry) / 30) * 0.25);
  }
  if (product.is_high_value && velocity.movement === "nonmoving") raw += 0.1;
  if (velocity.movement === "nonmoving") raw += 0.05;
  return Math.min(0.9, Math.max(0.6, Math.round(raw * 100) / 100));
}

const who = (product: RoutableProduct, brandName: string | null): string => {
  const name = product.product_name?.trim() || product.sku;
  return brandName ? `${name} (${product.sku}) · ${brandName}` : `${name} (${product.sku})`;
};

// Build the REPLENISH draft for a Fast/Healthy product running low.
export function buildReplenishDraft(
  product: RoutableProduct,
  velocity: Velocity,
  brandName: string | null
): WarehouseDraftBase {
  const name = product.product_name?.trim() || product.sku;
  const qty = suggestedReplenishQty(product, velocity);
  const coverText = fmtCover(velocity.daysOfCover);
  const trigger =
    product.reorder_point != null
      ? `stock ${int(velocity.stock ?? 0)} is at/under the reorder point of ${int(product.reorder_point)}`
      : `only ${coverText} of cover left (below the ${REPLENISH_COVER_DAYS}-day floor)`;

  const problem = `${MOVEMENT_LABEL[velocity.movement]} seller ${who(product, brandName)} is running low — ${trigger}.`;
  const root_cause = `At ~${velocity.avgDailyUnits.toFixed(1)} units/day, current stock of ${int(
    velocity.stock ?? 0
  )} covers about ${coverText}. Without a re-stock this SKU risks going out of stock while it's still selling.`;

  const evidence: EvidenceFact[] = [
    { label: "Movement", value: MOVEMENT_LABEL[velocity.movement] },
    { label: "Stock", value: velocity.stock != null ? int(velocity.stock) : "—" },
    { label: "Avg/day", value: velocity.avgDailyUnits > 0 ? velocity.avgDailyUnits.toFixed(1) : "0" },
    { label: "Days of cover", value: coverText },
    { label: "Reorder point", value: product.reorder_point != null ? int(product.reorder_point) : "not set" },
    { label: "Target cover", value: `${product.target_cover_days}d` },
  ];

  const recommendation =
    qty > 0
      ? `Open a replenishment task to stock up ~${int(qty)} units — enough to reach the ${product.target_cover_days}-day cover target. The human confirms the final PO; the OS only opens the task.`
      : `Open a replenishment task to review stock — cover is thin but the target-cover math nets zero, so the human sets the quantity. Nothing is ordered automatically.`;

  return {
    source_module: "warehouse",
    source_ref: { brand_id: product.brand_id, sku: product.sku },
    title: `Replenish ${name} (${product.sku})${brandName ? ` — ${brandName}` : ""}`,
    problem,
    root_cause,
    evidence,
    options: [], // replenish is a single clear next step, not a menu of tactics
    recommendation,
    estimated_impact: {
      summary:
        qty > 0
          ? `Keeps a live seller in stock — restores ~${product.target_cover_days} days of cover (~${int(qty)} units).`
          : `Prevents a stock-out on a live seller by putting the re-stock decision in front of the owner.`,
      gap_value: qty > 0 ? qty : null,
      gap_unit: qty > 0 ? "units" : null,
      is_money: false,
    },
    confidence: replenishConfidence(product, velocity),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "create_replenishment_task",
      payload: {
        brand_id: product.brand_id,
        sku: product.sku,
        product_name: name,
        suggested_qty: qty,
      },
    },
  };
}

// Build the PUSH-TO-SELL draft for dead / aging / near-expiry / high-value stock.
export function buildPushDraft(
  product: RoutableProduct,
  velocity: Velocity,
  aging: AgingFacts,
  brandName: string | null
): WarehouseDraftBase {
  const name = product.product_name?.trim() || product.sku;
  const urgent = isPushUrgent(product, velocity, aging);
  const tactic = suggestedTactic(product, velocity, aging);
  const movementLabel = MOVEMENT_LABEL[velocity.movement];

  // Problem line leads with the sharpest risk.
  const reasons: string[] = [];
  if (isPerishableUrgent(product, aging)) {
    reasons.push(`expires in ${fmtDays(aging.daysToExpiry)}`);
  }
  if (velocity.movement === "nonmoving") reasons.push(`0 units sold in the last 30 days`);
  if (velocity.movement === "slow" && aging.daysInStock != null && aging.daysInStock > 90) {
    reasons.push(`slow-moving and sitting ${aging.daysInStock} days`);
  }
  if (product.is_high_value && velocity.movement === "nonmoving") reasons.push(`high-value stock tied up`);
  const problem = `${movementLabel} stock ${who(product, brandName)} needs a demand push — ${
    reasons.join("; ") || "sitting stock at risk"
  }.`;

  const varText = aging.valueAtRisk != null ? peso(aging.valueAtRisk) : "—";
  const root_cause = isPerishableUrgent(product, aging)
    ? `A perishable within 30 days of expiry with ${int(velocity.stock ?? 0)} units on hand (${varText} at risk). Without a push, this stock is likely to be written off.`
    : `Stock that isn't converting to sales — ${int(
        velocity.stock ?? 0
      )} units (${varText}) tied up with no trailing demand. A demand-side push is needed to move it before it becomes dead capital.`;

  const evidence: EvidenceFact[] = [
    { label: "Movement", value: movementLabel },
    { label: "Days in stock", value: fmtDays(aging.daysInStock) },
    { label: "Days to expiry", value: product.is_perishable ? fmtDays(aging.daysToExpiry) : "n/a" },
    { label: "Value at risk", value: varText },
    { label: "Stock", value: velocity.stock != null ? int(velocity.stock) : "—" },
    { label: "Handling", value: handlingLabels(product) },
  ];

  const recommendation = `Open a push-to-sell task for the ecom/brand owner — recommended tactic: ${tactic.toLowerCase()}. The human picks the tactic and executes; nothing is discounted, listed or seeded automatically.`;

  return {
    source_module: "warehouse",
    source_ref: { brand_id: product.brand_id, sku: product.sku },
    title: `${urgent ? "⚠ " : ""}Push to sell: ${name} (${product.sku})${brandName ? ` — ${brandName}` : ""}`,
    problem,
    root_cause,
    evidence,
    options: PUSH_TACTICS,
    recommendation,
    estimated_impact: {
      summary: isPerishableUrgent(product, aging)
        ? `Avoids writing off ${varText} of perishable stock before it expires.`
        : `Frees up ${varText} of tied-up stock by converting dead inventory into sales.`,
      gap_value: aging.valueAtRisk,
      gap_unit: aging.valueAtRisk != null ? "PHP" : null,
      is_money: aging.valueAtRisk != null,
    },
    confidence: pushConfidence(product, velocity, aging),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "create_push_task",
      payload: {
        brand_id: product.brand_id,
        sku: product.sku,
        product_name: name,
        movement: velocity.movement as MovementClass,
        suggested_tactic: tactic,
        urgent,
      },
    },
  };
}
