// lib/cognition/types.ts — the shared shapes for the Cognition Loop.
//
// The loop reads ONE compartment (its field metric_keys) against the goalposts
// in metric_targets, then Tony emits a 3-possibility brief that lands in the
// existing action_requests spine (no new table, no parallel approval system).
//
// Two clusters of types live here:
//   • the READ model — what the deterministic scope reader produces from real
//     rows only (metric_compartments + metric_entries + metric_targets);
//   • the PLAN model — the strict JSON the single Claude call returns, plus the
//     richer per-option shape that rides in action_requests.options (jsonb).

import type { HealthDot } from "@/lib/metrics/types";

// ── READ: one metric's actual-vs-target reading ───────────────────────────────

// A single field in the compartment, read from real rows only. When there is no
// metric_entries row for the key, `value` is null and `hasEntry` is false — the
// display reads "—" and the model is told NOT to invent it.
export interface MetricReading {
  key: string; // metric_key, e.g. "ecom.rating_customer_service"
  label: string; // human label from the compartment field
  unit: string; // "percent" | "rating" | "hours" | "count" | …
  value: number | null; // the actual (manual floor, else api), or null when no row
  origin: "manual" | "api" | null; // provenance of the actual, null when no row
  hasEntry: boolean; // a real metric_entries row exists for this key/period
  period: string | null; // "period_start → period_end" of the latest entry, or null
  marketplace: string | null; // the entry's marketplace, or null
  // From metric_targets (the goalposts). Null when the metric has no target row.
  target: number | null;
  direction: "higher_better" | "lower_better" | "band" | null;
  greenMin: number | null;
  amberMin: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  notes: string | null;
  hasTarget: boolean;
  // Derived, deterministic verdict (green/amber/red) from healthFor, or null when
  // the value or the thresholds are missing. Never fabricated.
  dot: HealthDot;
  // A short, honest status phrase for the card + the model context.
  status: string;
}

// The full compartment reading the loop grounds on.
export interface CompartmentScope {
  codes: string[]; // the compartment code(s) read, e.g. ["T8","T9"]
  label: string; // a friendly label for the scope
  platform: string | null; // the compartment platform (marketplace), when uniform
  readings: MetricReading[]; // every field, real rows only (honest "—" where empty)
  grounded: number; // count of readings with a real entry (value != null)
}

// ── PLAN: the strict JSON Tony returns ────────────────────────────────────────

// The auto-vs-gate task split for one option. `auto` = steps the OS could run
// unattended; `gate` = steps that need a human decision. Both are honest lists —
// v1 executes NEITHER (the brief lands 'pending' and nothing auto-runs); the
// split only tells the approver what would be autonomous vs gated if approved.
export interface TaskSplit {
  auto: string[];
  gate: string[];
}

// One of the three possibilities Tony weighs, with its full reasoning.
export interface CognitionOption {
  label: string;
  what: string;
  why: string;
  how: string;
  impact: string;
  confidence: number; // 0..1
  task_split: TaskSplit;
}

// The strict JSON contract for the single Claude call.
export interface CognitionPlan {
  situation: string;
  root_cause: string;
  options: CognitionOption[]; // exactly 3
  recommendation: string;
  estimated_impact: string;
  risk_tier: number; // 0..4
  required_role: "department_head" | "coo" | "ceo";
}
