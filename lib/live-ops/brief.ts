// lib/live-ops/brief.ts — Claude analysis of ONE submitted Daily Live Report.
//
// After a report is submitted, this grounds Claude on the session's QUANT
// (live_sessions row + KPI-vs-previous) and QUAL (the assessment jsonb +
// reported bottlenecks) and returns a management-ready brief: performance
// rating, root cause, and intelligent recommendations. The output is the SAME
// BriefPayload shape the Account Review engine uses, so it persists to
// account_review_briefs (department='Live Operations') and its recommendations
// route to PENDING action_requests through the EXISTING
// /api/metrics/brief/recommend path — nothing auto-executes (D-005).
//
// Grounding contract: Claude reasons ONLY over the numbers/notes provided. A
// metric with no value is labelled "no data" and must be reported as such,
// never guessed. On a thin session, a parse failure, or an API error, the
// deterministic fallback stands and no figure is faked.

import { anthropicMessages } from "@/lib/briefings/anthropic";
import { emptyScenarioMeta } from "@/lib/briefings/account-review";
import type { BriefPayload, Priority } from "@/lib/briefings/account-review";
import type { LiveSession } from "@/lib/metrics/live";
import { sessionHours } from "@/lib/metrics/live";
import { deriveLiveOps } from "@/lib/live-ops/derive";
import { CATEGORY_LABEL, type LiveBottleneck } from "@/lib/live-ops/bottlenecks";

const SYSTEM_PROMPT =
  "You are Tony, the executive strategist for M-THRYVE, a Philippine TikTok Shop & Shopee commerce agency. " +
  "You analyze ONE Live Operations daily report and write a management-ready brief for the Live Operations team. " +
  "ABSOLUTE RULES: Use ONLY the numbers and notes provided. Never invent, estimate, or extrapolate a figure, product, " +
  "brand, or date. Any metric marked 'no data' MUST be described as having no data — never guess it. Give a concise " +
  "performance rating in the executive_summary (e.g. 'Strong', 'Mixed', 'Underperforming') justified by the real numbers, " +
  "compare KPIs to the previous session where both are present, and identify the most likely ROOT CAUSE of any shortfall " +
  "grounded in the reported challenges/bottlenecks. Recommendations are SUGGESTIONS only — they require human approval " +
  "before anything happens, so never phrase them as done or automatic, and never recommend spending money or contacting " +
  "anyone as if decided. Each recommendation names the target department that should act. " +
  "Respond with ONLY a single JSON object, no prose or code fence, of exactly this shape: " +
  '{"overall_performance":{"sales_trend":"","traffic_trend":"","conversion_trend":"","operational_efficiency":""},' +
  '"highlights":["..."],"concerns":["..."],' +
  '"recommendations":[{"action":"","rationale":"","priority":"high|medium|low","target_department":""}],' +
  '"executive_summary":""}. ' +
  "Keep each string concise. highlights/concerns/recommendations are arrays (may be empty if the data does not support them).";

function money(v: number | null): string {
  return v == null ? "no data" : `PHP ${Math.round(v).toLocaleString("en-US")}`;
}
function n(v: number | null): string {
  return v == null ? "no data" : Math.round(v).toLocaleString("en-US");
}
function pct(v: number | null): string {
  return v == null ? "no data" : `${Math.round(v * 10) / 10}%`;
}

// A one-line KPI comparison "current vs previous (Δ)".
function delta(label: string, cur: number | null, prev: number | null, fmt: (x: number | null) => string): string {
  if (cur == null && prev == null) return `- ${label}: no data`;
  let d = "";
  if (cur != null && prev != null && prev !== 0) {
    const pctChange = ((cur - prev) / Math.abs(prev)) * 100;
    d = ` (${pctChange >= 0 ? "+" : ""}${Math.round(pctChange)}% vs previous)`;
  }
  return `- ${label}: ${fmt(cur)}${prev != null ? ` [previous: ${fmt(prev)}]` : ""}${d}`;
}

export interface LiveBriefContext {
  session: LiveSession;
  previous: LiveSession | null;
  bottlenecks: LiveBottleneck[];
  brandName: string | null;
  anchorName: string | null;
}

export function buildLiveBriefPrompt(ctx: LiveBriefContext): string {
  const { session: s, previous: p, bottlenecks, brandName, anchorName } = ctx;
  const cur = deriveLiveOps([s]);
  const prev = p ? deriveLiveOps([p]) : null;
  const hrs = sessionHours(s);

  const lines: string[] = [];
  lines.push(`Live session: ${s.title ?? "Untitled"}${s.session_number ? ` (#${s.session_number})` : ""}`);
  lines.push(`Brand: ${brandName ?? "unassigned"} · Anchor: ${anchorName ?? "unassigned"}`);
  lines.push(`Total live hours: ${hrs != null ? Math.round(hrs * 10) / 10 : "no data"}`);
  lines.push("");
  lines.push("QUANT — KPIs (the only numbers you may use; compare to previous where shown):");
  lines.push(delta("GMV", cur.gmv, prev?.gmv ?? null, money));
  lines.push(delta("Total sales", cur.totalSales, prev?.totalSales ?? null, money));
  lines.push(delta("Orders", cur.orders, prev?.orders ?? null, n));
  lines.push(delta("AOV", cur.aov, prev?.aov ?? null, money));
  lines.push(delta("Conversion rate", cur.conversion, prev?.conversion ?? null, pct));
  lines.push(delta("Impressions", cur.impressions, prev?.impressions ?? null, n));
  lines.push(delta("Peak viewers", cur.peakViewers, prev?.peakViewers ?? null, n));
  lines.push(delta("Viewer retention", cur.viewerRetention, prev?.viewerRetention ?? null, pct));
  lines.push(delta("Product clicks", cur.productClicks, prev?.productClicks ?? null, n));
  lines.push(delta("CTR", cur.ctr, prev?.ctr ?? null, pct));
  lines.push(delta("Engagement rate", cur.engagementRate, prev?.engagementRate ?? null, pct));
  lines.push(delta("New followers", cur.newFollowers, prev?.newFollowers ?? null, n));

  const a = s.assessment ?? {};
  const qual: string[] = [];
  if (a.highlights) qual.push(`Highlights: ${a.highlights}`);
  if (a.challenges) qual.push(`Challenges: ${a.challenges}`);
  if (a.customer_insights) qual.push(`Customer insights: ${a.customer_insights}`);
  if (a.competitor_obs) qual.push(`Competitor observations: ${a.competitor_obs}`);
  if (qual.length) {
    lines.push("");
    lines.push("QUAL — Session assessment (reported by the team; cite as reported, not measured):");
    for (const q of qual) lines.push(`- ${q}`);
  }

  if (bottlenecks.length) {
    lines.push("");
    lines.push("REPORTED BOTTLENECKS (categorized issues to weigh in root-cause analysis):");
    for (const b of bottlenecks) {
      lines.push(`- [${b.severity}] ${CATEGORY_LABEL[b.category] ?? b.category}${b.note ? `: ${b.note}` : ""}`);
    }
  }

  lines.push("");
  lines.push(
    "If a trend cannot be judged from a present metric, state 'insufficient data' rather than guessing. Ground the " +
      "performance rating and root cause in the specific numbers and reported issues above."
  );
  return lines.join("\n");
}

// ── Parsing (local, mirrors the account-review parser) ────────────────────────
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
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}
function priority(v: unknown): Priority {
  const t = str(v).toLowerCase();
  return t === "high" || t === "medium" || t === "low" ? (t as Priority) : "medium";
}
function normRecs(v: unknown, fallbackDept: string) {
  if (!Array.isArray(v)) return [];
  const out = [];
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

// How many of the tracked KPIs actually carried a value — the grounding depth.
function countMetricsWithData(s: LiveSession): { withData: number; total: number } {
  const keys: (keyof LiveSession)[] = [
    "gmv", "total_sales", "orders", "units_sold", "conversion_rate",
    "impressions", "viewers", "peak_viewers", "viewer_retention",
    "product_clicks", "clicks", "ctr", "likes", "shares", "comments",
    "engagement_rate", "new_followers", "returning_viewers",
  ];
  let withData = 0;
  for (const k of keys) if (s[k] != null) withData += 1;
  return { withData, total: keys.length };
}

function fallbackPayload(ctx: LiveBriefContext, reason: string, model: string | null): BriefPayload {
  const { withData, total } = countMetricsWithData(ctx.session);
  const a = ctx.session.assessment ?? {};
  const concerns: string[] = [];
  if (withData === 0) concerns.push("No quantitative metrics were recorded for this session.");
  if (a.challenges) concerns.push(`Reported challenges: ${a.challenges}`);
  return {
    overall_performance: {
      sales_trend: "Insufficient data.",
      traffic_trend: "Insufficient data.",
      conversion_trend: "Insufficient data.",
      operational_efficiency: "Insufficient data.",
    },
    highlights: a.highlights ? [a.highlights] : [],
    concerns,
    recommendations: [
      {
        action: "Record the missing live-session metrics for a grounded review",
        rationale:
          "A grounded AI brief needs the session's recorded KPIs. Encoding GMV, orders, viewers and engagement will let Tony analyze the real numbers.",
        priority: "high",
        target_department: "Live Operations",
      },
    ],
    scenarios: [],
    scenario_meta: emptyScenarioMeta("Live Ops briefs do not project scenarios."),
    executive_summary: `${reason} ${withData} of ${total} KPIs recorded.`,
    meta: {
      grounded: false,
      model,
      generated_at: new Date().toISOString(),
      metrics_with_data: withData,
      metrics_total: total,
      note: reason,
    },
  };
}

// Generates the Live Ops brief. Always honest, never throws: the deterministic
// fallback covers a thin session, a parse failure, and any API error.
export async function generateLiveBrief(
  ctx: LiveBriefContext,
  opts: { model: string }
): Promise<BriefPayload> {
  const { withData, total } = countMetricsWithData(ctx.session);
  const a = ctx.session.assessment ?? {};
  const hasQual = Boolean(a.highlights || a.challenges || a.customer_insights || a.competitor_obs);

  // Nothing real to reason over → don't spend a model call, don't invent.
  if (withData === 0 && !hasQual && ctx.bottlenecks.length === 0) {
    return fallbackPayload(ctx, "Insufficient data to generate an AI brief.", opts.model);
  }

  let text: string;
  try {
    text = await anthropicMessages({
      model: opts.model,
      system: SYSTEM_PROMPT,
      user: buildLiveBriefPrompt(ctx),
      maxTokens: 1800,
    });
  } catch {
    return fallbackPayload(ctx, "The AI service was unavailable — the metrics below are read live and unaffected.", opts.model);
  }

  const parsed = parseJson<Record<string, unknown>>(text);
  if (!parsed) {
    return fallbackPayload(ctx, "The AI response could not be parsed — showing the grounded metrics only.", opts.model);
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
    recommendations: normRecs(parsed.recommendations, "Live Operations"),
    scenarios: [],
    scenario_meta: emptyScenarioMeta("Live Ops briefs do not project scenarios."),
    executive_summary: str(parsed.executive_summary) || `Live Operations brief for ${ctx.session.title ?? "session"}.`,
    meta: {
      grounded: true,
      model: opts.model,
      generated_at: new Date().toISOString(),
      metrics_with_data: withData,
      metrics_total: total,
      note: null,
    },
  };
  return payload;
}
