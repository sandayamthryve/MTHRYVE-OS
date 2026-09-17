// lib/briefings/account-review.ts — the AI Account Review Brief generator.
//
// Given a fully-grounded ReviewData (real metric values, targets, health,
// variance, mismatch flags — see lib/metrics/review.ts), this composes a strict
// grounded prompt, calls Anthropic server-side (the same ANTHROPIC_API_KEY and
// request path as every other briefing surface — no new key, no client
// exposure), and parses the result into a structured BriefPayload.
//
// Grounding contract enforced here:
//   • The model is handed ONLY the real values it may reason over. Metrics with
//     no value are labelled "no data" in the prompt and the model is told to
//     report them as such — never to infer or fill them.
//   • When the scope has no real data at all, we DON'T call the model — we return
//     an honest "insufficient data" payload. Same on a parse failure or API
//     error: the deterministic fallback stands, the numbers are never faked.

import { anthropicMessages } from "@/lib/briefings/anthropic";
import {
  formatMetricValue,
  formatTarget,
  formatVariance,
  HEALTH_LABEL,
  type MetricEntry,
  type ReviewData,
} from "@/lib/metrics/review";

// ── Payload shape (persisted to account_review_briefs.payload) ────────────────

export type Priority = "high" | "medium" | "low";

export interface OverallPerformance {
  sales_trend: string;
  traffic_trend: string;
  conversion_trend: string;
  operational_efficiency: string;
}

export interface Recommendation {
  action: string;
  rationale: string;
  priority: Priority;
  target_department: string;
}

// ── Scenarios (AI Brief 2.0) ──────────────────────────────────────────────────
// A projection grounded ONLY in the real metric trends + variance for the scope.
// Three per brief: an optimistic (best), a continuation (base), and a downside
// (worst). Each states its PREMISE (the assumption set — never left implicit),
// its PROJECTED_OUTCOME in plain language (never an invented number), the real
// metric DRIVERS behind it, a CONFIDENCE capped by how much real data backs it,
// and EVIDENCE_KEYS linking back to the exact metric rows the drivers cite.
export type ScenarioName = "best" | "base" | "worst";

export interface Scenario {
  name: ScenarioName;
  premise: string; // the stated assumption set this projection rests on
  projected_outcome: string; // plain-language outcome if the premise holds (no invented figures)
  drivers: string[]; // real metric labels driving the scenario (grounding)
  confidence: number; // 0..1, capped by data density — the model can't over-claim
  evidence_keys: string[]; // metric keys backing the drivers → UI evidence links
}

// Provenance for the scenario block, stamped by the generator (not the model).
export interface ScenarioMeta {
  grounded: boolean; // true when scenarios came from the model over real data
  model: string | null; // the deep-tier model used (or null when deterministic)
  data_density: number; // metrics_with_data / metrics_total (0..1)
  scored_metrics: number; // metrics with BOTH a real value and a target (judgeable)
  low_data: boolean; // true → confidence was capped and the UI flags the sparsity
  note: string | null; // an honest one-liner when the block is thin or a fallback
  generated_at: string;
}

export interface BriefPayload {
  overall_performance: OverallPerformance;
  highlights: string[];
  concerns: string[];
  recommendations: Recommendation[];
  scenarios: Scenario[]; // AI Brief 2.0 — grounded best/base/worst projections
  scenario_meta: ScenarioMeta;
  executive_summary: string;
  // Provenance, stamped by the generator (not the model), so the UI/export can
  // show honestly how the brief was produced.
  meta: {
    grounded: boolean; // true when the model reasoned over real data
    model: string | null;
    generated_at: string;
    metrics_with_data: number;
    metrics_total: number;
    note: string | null;
  };
}

// The honest empty scenario block: no projection, sparsity stated. Used when
// there is nothing real to project over, and as the pre-generation default so a
// BriefPayload is always structurally valid.
export function emptyScenarioMeta(note: string | null): ScenarioMeta {
  return {
    grounded: false,
    model: null,
    data_density: 0,
    scored_metrics: 0,
    low_data: true,
    note,
    generated_at: new Date().toISOString(),
  };
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are Tony, the executive strategist for M-THRYVE, a Philippine TikTok Shop & Shopee commerce agency. " +
  "You write a management-ready Account Review Brief for one department/period from the REAL metrics provided. " +
  "ABSOLUTE RULES: Use ONLY the numbers and facts given. Never invent, estimate, or extrapolate a figure, product, campaign, brand, or date. " +
  "Any metric marked 'no data' MUST be described as having no data — never guess its value or trend. " +
  "If the data is too sparse to support a section, say so plainly (e.g. 'insufficient data for conversion trend'). " +
  "Ground every highlight and concern in a specific metric that is actually present. Recommendations are SUGGESTIONS only — " +
  "they will require human approval before anything happens, so never phrase them as done or automatic, and never recommend " +
  "spending money or contacting anyone as if it were already decided. " +
  "Respond with ONLY a single JSON object, no prose or code fence, of exactly this shape: " +
  '{"overall_performance":{"sales_trend":"","traffic_trend":"","conversion_trend":"","operational_efficiency":""},' +
  '"highlights":["..."],"concerns":["..."],' +
  '"recommendations":[{"action":"","rationale":"","priority":"high|medium|low","target_department":""}],' +
  '"executive_summary":""}. ' +
  "Keep each string concise. highlights/concerns/recommendations are arrays (may be empty if the data does not support them).";

function metricLine(e: MetricEntry): string {
  const val = formatMetricValue(e);
  const tgt = e.target !== null ? `, target ${formatTarget(e)}` : ", no target";
  const varc = e.variance_pct !== null || e.variance !== null ? `, variance ${formatVariance(e)}` : "";
  const health = `, health ${HEALTH_LABEL[e.health]}`;
  const state = e.value === null ? " [NO DATA]" : "";
  return `- ${e.label}: ${val}${tgt}${varc}${health} (origin: ${e.origin})${state}`;
}

export function buildReviewUserPrompt(data: ReviewData): string {
  const { scope, entries, rollup, mismatch_flags, narrative } = data;
  const lines: string[] = [];
  lines.push(`Department scope: ${scope.department}${scope.brand_name ? ` · brand: ${scope.brand_name}` : ""}`);
  lines.push(`Period: ${scope.period_start} to ${scope.period_end}`);
  lines.push(
    `Health rollup: ${rollup.label}${rollup.score !== null ? ` (${rollup.score}/100 over ${rollup.scored} scored metric(s))` : ""} — ` +
      `${rollup.good} on track, ${rollup.watch} watch, ${rollup.risk} at risk, ${rollup.none} unscored/no-data.`
  );
  lines.push("");
  lines.push("METRICS (the only facts you may use):");
  for (const e of entries) lines.push(metricLine(e));
  if (mismatch_flags.length) {
    lines.push("");
    lines.push("DATA QUALITY FLAGS (surface these honestly where relevant):");
    for (const f of mismatch_flags) lines.push(`- ${f}`);
  }
  const narrativeParts: string[] = [];
  if (narrative.ongoing_tasks) narrativeParts.push(`Ongoing tasks: ${narrative.ongoing_tasks}`);
  if (narrative.expected_outputs) narrativeParts.push(`Expected outputs: ${narrative.expected_outputs}`);
  if (narrative.challenges) narrativeParts.push(`Reported challenges: ${narrative.challenges}`);
  if (narrativeParts.length) {
    lines.push("");
    lines.push("DEPARTMENT-REPORTED CONTEXT (qualitative, from the team — cite as reported, not measured):");
    for (const p of narrativeParts) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push(
    "Note: traffic and conversion are not directly measured in the metrics above. If they cannot be inferred " +
      "from a present metric, state 'insufficient data' for those trends rather than guessing."
  );
  return lines.join("\n");
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(str).filter(Boolean);
}

function priority(v: unknown): Priority {
  const s = str(v).toLowerCase();
  return s === "high" || s === "medium" || s === "low" ? (s as Priority) : "medium";
}

function normalizeRecommendations(v: unknown, fallbackDept: string): Recommendation[] {
  if (!Array.isArray(v)) return [];
  const out: Recommendation[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const action = str(r.action);
    if (!action) continue;
    out.push({
      action,
      rationale: str(r.rationale),
      priority: priority(r.priority),
      target_department: str(r.target_department) || fallbackDept,
    });
  }
  return out;
}

// A deterministic, honest brief for when the model can't or shouldn't run. It
// fabricates nothing: it names exactly which metrics are missing and asks for
// the data, and it still routes a single "record the metrics" recommendation.
function insufficientDataPayload(data: ReviewData, reason: string, model: string | null): BriefPayload {
  const missing = data.entries.filter((e) => e.value === null).map((e) => e.label);
  const present = data.entries.filter((e) => e.value !== null).map((e) => e.label);
  const dataLine =
    present.length > 0
      ? `Only ${present.length} of ${data.entries.length} metric(s) have recorded values (${present.join(", ")}).`
      : "No metrics have recorded values for this scope and period.";
  return {
    overall_performance: {
      sales_trend: "Insufficient data.",
      traffic_trend: "Insufficient data (traffic is not measured for this scope).",
      conversion_trend: "Insufficient data (conversion is not measured for this scope).",
      operational_efficiency: present.includes("Operational Efficiency")
        ? "See the recorded efficiency metric above."
        : "Insufficient data — no efficiency snapshot recorded.",
    },
    highlights: [],
    concerns: [
      dataLine,
      missing.length ? `No data on record for: ${missing.join(", ")}.` : "",
    ].filter(Boolean),
    recommendations: [
      {
        action: `Record the missing metrics for ${data.scope.department} for ${data.scope.period_start}–${data.scope.period_end}`,
        rationale:
          "A grounded review cannot be produced without recorded values. Entering the department snapshot (and, if brand-scoped, the brand-platform rows) will let Tony analyze the real numbers.",
        priority: "high",
        target_department: data.scope.department,
      },
    ],
    scenarios: [],
    scenario_meta: emptyScenarioMeta(
      "Scenarios need recorded metric trends to project over — none are on record for this scope and period."
    ),
    executive_summary: `${reason} ${dataLine} Enter the missing metrics to generate a grounded Account Review Brief.`,
    meta: {
      grounded: false,
      model,
      generated_at: new Date().toISOString(),
      metrics_with_data: present.length,
      metrics_total: data.entries.length,
      note: reason,
    },
  };
}

// ── Public generator ──────────────────────────────────────────────────────────

// Generates the brief. `model` is the Anthropic model id (tier-resolved by the
// caller). Returns a structured BriefPayload — always honest, never throwing:
// the deterministic fallback covers a thin-data scope, a parse failure, and any
// API error.
export async function generateAccountReviewBrief(
  data: ReviewData,
  opts: { model: string }
): Promise<BriefPayload> {
  const metricsWithData = data.entries.filter((e) => e.value !== null).length;

  // Nothing real to reason over → don't spend a model call, don't invent.
  if (!data.hasData) {
    return insufficientDataPayload(data, "Insufficient data to generate an AI brief.", opts.model);
  }

  let text: string;
  try {
    text = await anthropicMessages({
      model: opts.model,
      system: SYSTEM_PROMPT,
      user: buildReviewUserPrompt(data),
      maxTokens: 1800,
    });
  } catch {
    return insufficientDataPayload(
      data,
      "The AI service was unavailable — the metrics below are read live and unaffected.",
      opts.model
    );
  }

  const parsed = parseJson<Record<string, unknown>>(text);
  if (!parsed) {
    return insufficientDataPayload(data, "The AI response could not be parsed — showing the grounded metrics only.", opts.model);
  }

  const op = (parsed.overall_performance ?? {}) as Record<string, unknown>;
  const payload: BriefPayload = {
    overall_performance: {
      sales_trend: str(op.sales_trend) || "Insufficient data.",
      traffic_trend: str(op.traffic_trend) || "Insufficient data.",
      conversion_trend: str(op.conversion_trend) || "Insufficient data.",
      operational_efficiency: str(op.operational_efficiency) || "Insufficient data.",
    },
    highlights: strArray(parsed.highlights),
    concerns: strArray(parsed.concerns),
    recommendations: normalizeRecommendations(parsed.recommendations, data.scope.department),
    // Scenarios are generated separately (deep tier) and merged by the caller;
    // start from the honest empty block so the payload is always valid on its own.
    scenarios: [],
    scenario_meta: emptyScenarioMeta(null),
    executive_summary: str(parsed.executive_summary),
    meta: {
      grounded: true,
      model: opts.model,
      generated_at: new Date().toISOString(),
      metrics_with_data: metricsWithData,
      metrics_total: data.entries.length,
      note: null,
    },
  };
  if (!payload.executive_summary) {
    payload.executive_summary = `Account Review Brief for ${data.scope.department} (${data.scope.period_start}–${data.scope.period_end}). Health: ${data.rollup.label}.`;
  }
  return payload;
}
