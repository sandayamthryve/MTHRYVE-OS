// lib/cognition/plan.ts — the PLAN half of the Cognition Loop.
//
// ONE Claude call (Tony's existing Anthropic client — same ANTHROPIC_API_KEY,
// same endpoint, via lib/briefings/anthropic) turns the grounded compartment
// reading into a strict-JSON 3-possibility brief, then this maps that JSON onto
// the action_requests columns. It NEVER writes — the producer stamps org_id /
// created_by / status and inserts. It NEVER fabricates: the prompt forces every
// claim to cite the metric+target it came from, forbids invented numbers, and
// tells Tony to say the data is too thin rather than guess.

import { anthropicMessagesWithUsage, type AnthropicUsage } from "@/lib/briefings/anthropic";
import { EMPTY } from "@/lib/metrics/format";
import type {
  EvidenceFact,
  EstimatedImpact,
  RequiredRole,
} from "@/lib/actions/types";
import type { CompartmentScope, CognitionOption, CognitionPlan, MetricReading } from "./types";

// The strict grounding contract. Tony may reason ONLY over the readings handed
// in; every option must cite the metric(s) + target it rests on; no number that
// isn't in the context may appear; and if the grounded data is too thin to plan
// responsibly, Tony must say so in `situation` and still return valid JSON
// (options may then be conservative "gather data" moves — never invented wins).
const SYSTEM_PROMPT = [
  "You are Tony, the cognition engine for a Philippine TikTok Shop & Shopee agency OS.",
  "You are given ONE compartment's live metrics, each with its actual value, its target, the",
  "target direction/bands, and a deterministic status. Some metrics have NO entry — they read",
  '"—". You must NEVER invent a value, target, cause, or trend for a metric that reads "—", and',
  "you must NEVER state a number that is not in the context. Every claim in every option must cite",
  "the specific metric label(s) and target it came from. If the grounded metrics are too thin to",
  "plan responsibly, say so plainly in `situation` and keep the options to honest data-gathering",
  "moves — do not manufacture a strategy.",
  "",
  "Return ONLY strict JSON (no prose, no code fence) of EXACTLY this shape:",
  "{",
  '  "situation": string,            // what the numbers show, grounded, 1-3 sentences',
  '  "root_cause": string,           // the most likely driver, tied to the cited metrics',
  '  "options": [                    // EXACTLY 3 distinct possibilities',
  "    {",
  '      "label": string,            // a short name for the move',
  '      "what": string,             // what the move is',
  '      "why": string,              // why it helps, citing the metric+target',
  '      "how": string,              // how it would be done',
  '      "impact": string,           // the expected effect on the cited metric(s)',
  '      "confidence": number,       // 0..1 confidence in this option',
  '      "task_split": { "auto": string[], "gate": string[] }  // steps that could run unattended vs need a human',
  "    }, { … }, { … }",
  "  ],",
  '  "recommendation": string,       // which option you recommend and why, grounded',
  '  "estimated_impact": string,     // the measurable gain if the recommendation lands',
  '  "risk_tier": number,            // 0 (trivial) .. 4 (critical) reversibility/blast-radius of acting',
  '  "required_role": string         // "department_head" | "coo" | "ceo" — who should approve',
  "}",
  "Nothing you propose auto-executes; a human approves first. Keep each field concise.",
].join("\n");

// Build the grounded user context — real readings only, honest "—" for empties.
// The model sees the compartment label, then one line per metric carrying the
// actual, origin, period, target, direction/bands, notes and the derived status.
export function buildUserContext(scope: CompartmentScope): string {
  const lines: string[] = [];
  lines.push(`COMPARTMENT SCOPE: ${scope.label}`);
  if (scope.platform) lines.push(`Marketplace: ${scope.platform}`);
  lines.push(
    `${scope.grounded} of ${scope.readings.length} metrics have a real entry; the rest read "${EMPTY}" and must not be reasoned about as if known.`
  );
  lines.push("");
  lines.push("METRICS (actual vs target — ground every claim in these):");
  for (const r of scope.readings) {
    lines.push(metricLine(r));
  }
  return lines.join("\n");
}

function fmtVal(r: MetricReading): string {
  if (r.value == null) return EMPTY;
  if (r.unit === "percent") return `${r.value}%`;
  if (r.unit === "rating") return `${r.value}/5`;
  if (r.unit === "hours") return `${r.value}h`;
  return `${r.value}`;
}

function metricLine(r: MetricReading): string {
  const parts: string[] = [];
  parts.push(`• ${r.label} [${r.key}]: actual ${fmtVal(r)}`);
  if (r.hasEntry && r.origin) parts.push(`(${r.origin}${r.period ? `, ${r.period}` : ""})`);
  if (r.hasTarget) {
    const bits: string[] = [];
    if (r.target != null) bits.push(`target ${r.target}`);
    if (r.direction) bits.push(r.direction);
    if (r.greenMin != null) bits.push(`green≥${r.greenMin}`);
    if (r.amberMin != null) bits.push(`amber≥${r.amberMin}`);
    parts.push(`| ${bits.join(", ")}`);
  } else {
    parts.push("| no target set");
  }
  parts.push(`| status: ${r.status}`);
  if (r.notes) parts.push(`| note: ${r.notes}`);
  return parts.join(" ");
}

// Minimal, dependency-free JSON extraction (handles a ```json fence or prose).
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
function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.6;
  return Math.min(1, Math.max(0, n));
}
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter(Boolean);
}

// Normalize a raw option object; drop it (return null) if it has no substance.
function normalizeOption(raw: unknown): CognitionOption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = str(o.label);
  const what = str(o.what);
  if (!label && !what) return null;
  const split = (o.task_split ?? {}) as Record<string, unknown>;
  return {
    label: label || "Option",
    what,
    why: str(o.why),
    how: str(o.how),
    impact: str(o.impact),
    confidence: clamp01(o.confidence),
    task_split: { auto: strList(split.auto), gate: strList(split.gate) },
  };
}

const ALLOWED_ROLES: RequiredRole[] = ["department_head", "coo", "ceo"];

// Validate + normalize the model JSON into a CognitionPlan. Returns null when the
// response is too malformed to trust (missing situation or fewer than 2 real
// options) — the producer then records the failed call and drafts nothing.
export function normalizePlan(raw: unknown): CognitionPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const situation = str(p.situation);
  if (!situation) return null;

  const options = Array.isArray(p.options)
    ? p.options.map(normalizeOption).filter((x): x is CognitionOption => x != null)
    : [];
  if (options.length < 2) return null; // a "3-possibility brief" needs real options

  let riskTier = Math.round(Number(p.risk_tier));
  if (!Number.isFinite(riskTier)) riskTier = 3;
  riskTier = Math.min(4, Math.max(0, riskTier));

  const roleRaw = str(p.required_role).toLowerCase();
  const required_role = (ALLOWED_ROLES as string[]).includes(roleRaw)
    ? (roleRaw as RequiredRole)
    : "coo";

  return {
    situation,
    root_cause: str(p.root_cause),
    options: options.slice(0, 3),
    recommendation: str(p.recommendation),
    estimated_impact: str(p.estimated_impact),
    risk_tier: riskTier,
    required_role,
  };
}

// The result of the single Claude call. `usage` is ALWAYS returned when a call
// was actually made (so the producer can log ai_usage_log honestly), even when
// the JSON failed to parse (plan null).
export interface PlanResult {
  plan: CognitionPlan | null;
  usage: AnthropicUsage;
  model: string;
  raw: string;
}

// An optional executive LENS layered on the same grounded loop. A council member
// (COO AI, CMO AI, …) passes its persona here so the reasoning is framed through
// that officer's priorities WITHOUT loosening the grounding contract: the lens
// only shapes which options are prioritized and how the situation is framed — the
// system prompt's "never invent a number" rules stay absolute and come first.
export interface CognitionLens {
  name: string; // e.g. "COO AI"
  title: string; // e.g. "Operations & Fulfilment Director"
  persona: string; // the member's operating persona
}

function lensDirective(lens: CognitionLens): string {
  return [
    "",
    `COUNCIL LENS — reason as ${lens.name} (${lens.title}), a member of the executive AI council.`,
    `Operating persona: ${lens.persona}`,
    "This lens shapes WHICH options you prioritize and how you frame the situation. It NEVER",
    "licenses inventing, softening, or extrapolating a number: the grounding rules above are",
    'absolute and come first. Ground every claim in the metrics given; where they read "—", say so.',
  ].join("\n");
}

// Run the ONE Claude call for a grounded scope. Throws only if the API itself
// errors (no key / network) — the producer catches that. A malformed but
// successful response returns { plan: null } WITH usage so the spend is still
// recorded. An optional `lens` frames the reasoning as a council member without
// changing the read half or the grounding contract.
export async function runCognitionPlan(
  scope: CompartmentScope,
  model: string,
  opts?: { lens?: CognitionLens }
): Promise<PlanResult> {
  const system = opts?.lens ? `${SYSTEM_PROMPT}\n${lensDirective(opts.lens)}` : SYSTEM_PROMPT;
  const { text, usage } = await anthropicMessagesWithUsage({
    model,
    system,
    user: buildUserContext(scope),
    maxTokens: 4096,
  });
  const parsed = parseJson<Record<string, unknown>>(text);
  return { plan: parsed ? normalizePlan(parsed) : null, usage, model, raw: text };
}

// ── Map the plan onto action_requests columns ─────────────────────────────────

// The drafted row (minus org_id / created_by / status — the producer stamps
// those so the RLS with_check passes). proposed_action is NULL on purpose: a
// Cognition brief is recommendation-only, so on approval the existing decide
// path rests it at 'approved' and NOTHING auto-executes.
export interface CognitionDraft {
  source_module: "cognition_loop";
  source_ref: { compartment: string; codes: string[] };
  title: string;
  problem: string;
  root_cause: string | null;
  evidence: EvidenceFact[];
  options: CognitionOption[];
  recommendation: string | null;
  estimated_impact: EstimatedImpact;
  confidence: number | null;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: null;
}

// Evidence = every field's honest actual-vs-target, real rows AND "—" alike, so
// the card shows exactly what Tony grounded on (including the gaps).
function evidenceFrom(scope: CompartmentScope): EvidenceFact[] {
  return scope.readings.map((r) => ({ label: r.label, value: r.status }));
}

// Average option confidence → the row's confidence (0..1), or null if none.
function planConfidence(plan: CognitionPlan): number | null {
  if (plan.options.length === 0) return null;
  const sum = plan.options.reduce((a, o) => a + o.confidence, 0);
  return Math.round((sum / plan.options.length) * 100) / 100;
}

export function planToDraft(plan: CognitionPlan, scope: CompartmentScope): CognitionDraft {
  const codeLabel = scope.codes.join(" + ");
  return {
    source_module: "cognition_loop",
    source_ref: { compartment: codeLabel, codes: scope.codes },
    title: `Cognition Loop · ${codeLabel} — ${scope.grounded}/${scope.readings.length} metrics grounded`,
    problem: plan.situation,
    root_cause: plan.root_cause || null,
    evidence: evidenceFrom(scope),
    options: plan.options,
    recommendation: plan.recommendation || null,
    estimated_impact: { summary: plan.estimated_impact || null },
    confidence: planConfidence(plan),
    risk_tier: plan.risk_tier,
    required_role: plan.required_role,
    proposed_action: null,
  };
}

// A scope is too thin to plan when NO field has a real entry — every metric
// reads "—". The producer skips the model call entirely in that case (no spend,
// no invented brief).
export function isThinScope(scope: CompartmentScope): boolean {
  return scope.grounded === 0;
}
