// lib/briefings/account-review-scenarios.ts — the AI Brief 2.0 scenario engine.
//
// Given a fully-grounded ReviewData, this produces THREE projections — best,
// base, worst — that rest ONLY on the real metric trends + variance already in
// the brief. The contract mirrors the rest of the briefing layer: nothing is
// invented.
//
//   • A deterministic SCENARIO BASIS is built first from the real entries (their
//     value, target, signed variance, health, and direction) plus the data
//     density (how many metrics actually have a value). This is the ONLY material
//     the projection may reason over.
//   • The model (the DEEP / premium tier — scenario reasoning is the most
//     demanding surface, so it is fixed here rather than left to the role default)
//     phrases each scenario. Every driver it cites is matched back to a REAL
//     metric; a driver that names no real metric is dropped, so a scenario can
//     never lean on a fabricated signal.
//   • CONFIDENCE is never taken from the model at face value — it is clamped by
//     data density and the number of judgeable (value+target) metrics, so a thin
//     scope can't yield a confident projection. When data is sparse, low_data is
//     set and the UI/export flag it honestly.
//   • If the model is unavailable or unparseable, a deterministic, direction-only
//     fallback still returns three grounded scenarios (real drivers, explicit
//     assumptions, low confidence) — never invented numbers.

import { anthropicMessages } from "@/lib/briefings/anthropic";
import { TIER_MODEL, type ModelTier } from "@/lib/ai/models";
import {
  formatMetricValue,
  formatTarget,
  formatVariance,
  HEALTH_LABEL,
  type MetricEntry,
  type ReviewData,
} from "@/lib/metrics/review";
import type { Scenario, ScenarioName, ScenarioMeta } from "@/lib/briefings/account-review";

// Scenarios always run on the DEEP tier. This is a server-fixed choice for a
// single demanding analysis surface (like the finance loop's service-role read),
// not a user-selectable model grant — so it does not depend on the caller's role.
export const SCENARIO_TIER: ModelTier = "premium";

const SCENARIO_NAMES: ScenarioName[] = ["best", "base", "worst"];

export interface ScenarioResult {
  scenarios: Scenario[];
  meta: ScenarioMeta;
}

// ── Deterministic basis ───────────────────────────────────────────────────────

interface BasisMetric {
  key: string;
  label: string;
  value_txt: string;
  target_txt: string;
  variance_txt: string;
  health: string;
  scored: boolean; // has BOTH a real value and a target → its variance is judged
  valued: boolean; // has a real value (may lack a target)
}

interface ScenarioBasis {
  metrics: BasisMetric[];
  valued: number; // metrics with a real value
  scored: number; // metrics with a value AND a target (variance judgeable)
  total: number;
  density: number; // valued / total (0..1)
}

function buildBasis(data: ReviewData): ScenarioBasis {
  const metrics: BasisMetric[] = data.entries.map((e: MetricEntry) => {
    const valued = e.value !== null;
    const scored = valued && e.target !== null && e.health !== "none";
    return {
      key: e.key,
      label: e.label,
      value_txt: formatMetricValue(e),
      target_txt: formatTarget(e),
      variance_txt: formatVariance(e),
      health: HEALTH_LABEL[e.health],
      scored,
      valued,
    };
  });
  const valued = metrics.filter((m) => m.valued).length;
  const scored = metrics.filter((m) => m.scored).length;
  const total = metrics.length || 1;
  return { metrics, valued, scored, total, density: valued / total };
}

// Confidence ceiling from how much real data backs the projection. Density and
// the count of judgeable metrics both pull it down; a scope with < 2 scored
// metrics can never read as more than tentative. best/worst are inherently less
// certain than the base continuation, so they sit a notch lower.
function confidenceCeiling(basis: ScenarioBasis, name: ScenarioName): number {
  let cap = 0.25 + 0.6 * basis.density; // 0.25 (empty) .. 0.85 (full coverage)
  if (basis.scored < 2) cap = Math.min(cap, 0.45);
  if (basis.scored < 1) cap = Math.min(cap, 0.3);
  if (name !== "base") cap -= 0.1; // downside/upside tails are less certain
  return Math.max(0.1, Math.min(0.85, Math.round(cap * 100) / 100));
}

function isLowData(basis: ScenarioBasis): boolean {
  return basis.density < 0.5 || basis.scored < 2;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are Tony, the executive strategist for M-THRYVE, a Philippine TikTok Shop & Shopee commerce agency. " +
  "You are handed the REAL, current metrics for one department/period — each with its value, target, signed variance, and health. " +
  "Produce exactly THREE forward scenarios for the NEXT comparable period: 'best', 'base', and 'worst'. " +
  "ABSOLUTE RULES: Reason ONLY from the metric trends and variances given. NEVER invent, estimate, or state a specific future number, product, campaign, or date. " +
  "Each scenario's 'premise' MUST state the assumption set it rests on in plain words (e.g. 'if the current +12% ROAS variance holds and returns stay flat'). " +
  "Each 'projected_outcome' describes the DIRECTION and consequence in words — never a fabricated figure. " +
  "'drivers' MUST be a list of metric labels chosen from EXACTLY the labels provided — do not name a metric that is not in the list. " +
  "If the data is too thin to project, say so plainly in the premise and keep the scenario directional and cautious. " +
  "Respond with ONLY a single JSON object, no prose or code fence, of exactly this shape: " +
  '{"scenarios":[{"name":"best|base|worst","premise":"","projected_outcome":"","drivers":["<metric label>"]}]}. ' +
  "Keep each string to one or two concise sentences.";

function buildUserPrompt(data: ReviewData, basis: ScenarioBasis): string {
  const lines: string[] = [];
  lines.push(
    `Department scope: ${data.scope.department}${data.scope.brand_name ? ` · brand: ${data.scope.brand_name}` : ""}`
  );
  lines.push(`Period just reviewed: ${data.scope.period_start} to ${data.scope.period_end}`);
  lines.push(
    `Data coverage: ${basis.valued} of ${basis.total} metrics have a recorded value; ${basis.scored} are judged against a target.`
  );
  lines.push("");
  lines.push("METRIC TRENDS + VARIANCE (the ONLY signals you may project from):");
  for (const m of basis.metrics) {
    if (!m.valued) {
      lines.push(`- ${m.label}: NO DATA (do not project on this metric).`);
      continue;
    }
    lines.push(
      `- ${m.label}: ${m.value_txt} (target ${m.target_txt}, variance ${m.variance_txt}, health ${m.health}).`
    );
  }
  lines.push("");
  lines.push(
    "Note: there is a single review window here, not a multi-period series — treat variance-vs-target as the trend signal and state that as an assumption. Do not imply a longer history than the data shows."
  );
  return lines.join("\n");
}

// ── Parsing + normalization ───────────────────────────────────────────────────

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

function coerceName(v: unknown): ScenarioName | null {
  const s = str(v).toLowerCase();
  return s === "best" || s === "base" || s === "worst" ? (s as ScenarioName) : null;
}

// Match a model-named driver back to a REAL metric label (exact, then loose
// substring). Returns the matched entry or null — an unmatched driver is dropped
// so a scenario can never cite a metric that isn't in the grounded set.
function matchDriver(driver: string, basis: ScenarioBasis): BasisMetric | null {
  const d = driver.trim().toLowerCase();
  if (!d) return null;
  const exact = basis.metrics.find((m) => m.label.toLowerCase() === d);
  if (exact) return exact;
  return (
    basis.metrics.find(
      (m) => m.valued && (m.label.toLowerCase().includes(d) || d.includes(m.label.toLowerCase()))
    ) ?? null
  );
}

function normalizeDrivers(
  raw: unknown,
  basis: ScenarioBasis
): { drivers: string[]; keys: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  const drivers: string[] = [];
  const keys: string[] = [];
  for (const d of list) {
    const m = matchDriver(str(d), basis);
    if (m && !keys.includes(m.key)) {
      drivers.push(m.label);
      keys.push(m.key);
    }
  }
  return { drivers, keys };
}

// ── Deterministic fallback ────────────────────────────────────────────────────
// Three honest, direction-only scenarios built purely from the real basis. Used
// when the model is unavailable/unparseable and to fill any scenario the model
// omitted. No invented numbers — only the direction the real variance implies.

const FRAME: Record<ScenarioName, { premise: (n: number) => string; outcome: string }> = {
  best: {
    premise: (n) =>
      `Assumes the ${n} tracked metric(s) sustain their current trend and the on-track ones improve further, with no new drag.`,
    outcome:
      "Health holds or edges up as the leading metrics carry; upside is directional only — no specific figure is projected from a single window.",
  },
  base: {
    premise: (n) =>
      `Assumes the current variance-vs-target across the ${n} tracked metric(s) simply persists into the next comparable period.`,
    outcome:
      "The scope stays roughly where it is; the same metrics that lead and lag today continue to, absent a deliberate change.",
  },
  worst: {
    premise: (n) =>
      `Assumes the metrics currently at risk deteriorate further and no corrective action lands across the ${n} tracked metric(s).`,
    outcome:
      "Health slips as the lagging metrics widen their gap to target; the downside is directional — magnitude can't be projected from one window.",
  },
};

function deterministicScenarios(basis: ScenarioBasis): Scenario[] {
  // Drivers = the judgeable metrics (value + target), or, failing that, any
  // valued metric. Keys back the UI evidence links.
  const backing = basis.metrics.filter((m) => m.scored);
  const pool = backing.length ? backing : basis.metrics.filter((m) => m.valued);
  const drivers = pool.map((m) => m.label);
  const keys = pool.map((m) => m.key);
  return SCENARIO_NAMES.map((name) => ({
    name,
    premise: FRAME[name].premise(pool.length),
    projected_outcome: FRAME[name].outcome,
    drivers,
    confidence: confidenceCeiling(basis, name),
    evidence_keys: keys,
  }));
}

// ── Public generator ──────────────────────────────────────────────────────────

// Generates the three scenarios. Never throws — an API error or parse failure
// falls back to deterministic, grounded, low-confidence scenarios. `model` is the
// deep-tier model id (default SCENARIO_TIER); pass through for testability.
export async function generateScenarios(
  data: ReviewData,
  opts: { model?: string } = {}
): Promise<ScenarioResult> {
  const model = opts.model ?? TIER_MODEL[SCENARIO_TIER];
  const basis = buildBasis(data);
  const lowData = isLowData(basis);

  // Nothing real to project over → honest empty block, no model call.
  if (basis.valued === 0) {
    return {
      scenarios: [],
      meta: {
        grounded: false,
        model: null,
        data_density: 0,
        scored_metrics: 0,
        low_data: true,
        note: "No recorded metric values for this scope — scenarios need real trends to project over.",
        generated_at: new Date().toISOString(),
      },
    };
  }

  const det = deterministicScenarios(basis);
  const detByName = new Map(det.map((s) => [s.name, s] as const));

  let modelScenarios: Partial<Record<ScenarioName, Scenario>> = {};
  let grounded = false;
  let note: string | null = lowData
    ? "Sparse data — projections are directional and confidence is capped accordingly."
    : null;

  try {
    const text = await anthropicMessages({
      model,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(data, basis),
      maxTokens: 1200,
    });
    const parsed = parseJson<{ scenarios?: unknown }>(text);
    const rawList = Array.isArray(parsed?.scenarios) ? (parsed!.scenarios as unknown[]) : [];
    for (const raw of rawList) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const name = coerceName(r.name);
      if (!name || modelScenarios[name]) continue;
      const premise = str(r.premise);
      const outcome = str(r.projected_outcome);
      if (!premise && !outcome) continue;
      const { drivers, keys } = normalizeDrivers(r.drivers, basis);
      // A scenario with no real driver is not grounded — fall back to the
      // deterministic one for that name rather than keep an unbacked projection.
      if (drivers.length === 0) continue;
      modelScenarios[name] = {
        name,
        premise: premise || detByName.get(name)!.premise,
        projected_outcome: outcome || detByName.get(name)!.projected_outcome,
        drivers,
        confidence: confidenceCeiling(basis, name), // clamp — never trust a model-stated confidence
        evidence_keys: keys,
      };
    }
    grounded = Object.keys(modelScenarios).length > 0;
    if (!grounded && note === null) {
      note = "AI phrasing was unavailable — showing grounded, direction-only scenarios.";
    }
  } catch {
    note = "AI service was unavailable — showing grounded, direction-only scenarios from the real variance.";
  }

  // Assemble best/base/worst in a stable order, filling any gap the model left
  // with the deterministic (still grounded) scenario for that name.
  const scenarios: Scenario[] = SCENARIO_NAMES.map(
    (name) => modelScenarios[name] ?? detByName.get(name)!
  );

  return {
    scenarios,
    meta: {
      grounded,
      model: grounded ? model : null,
      data_density: Math.round(basis.density * 100) / 100,
      scored_metrics: basis.scored,
      low_data: lowData,
      note,
      generated_at: new Date().toISOString(),
    },
  };
}
