// lib/briefings/metric-briefs.ts — the per-metric "✦ AI Brief" for Mission
// Control. Each KPI and chart gets a four-line brief: WHAT / WHY / HOW /
// POTENTIAL IMPACT.
//
// RENDER NEVER CALLS THE MODEL. This module used to call Anthropic INLINE during
// Command Center render (wrapped in unstable_cache, but a stale/expired key or a
// changed figure re-ran the model on the request path behind a 12s timeout).
// Live Vercel logs showed ~590 blocking failures of this exact call surfacing as
// the dashboard "hangs". So the split is now hard:
//   • loadMetricBriefs() (RENDER) reads the LAST CACHED blurb from
//     public.metric_brief_cache — a fast org-scoped select, never a model call.
//     A missing/failed blurb renders "—" instantly. It never awaits the model.
//   • refreshMetricBriefs() (BACKGROUND, off the request path — the GitHub
//     Actions scheduler → /api/automation/metric-briefs) regenerates the blurbs
//     with the cheapest model and upserts them into the cache.
//
// Grounding contract (never fabricate):
//   • WHAT and HOW are DERIVED DETERMINISTICALLY here from the real metric —
//     WHAT restates the actual value, HOW names the measurement source. No model
//     is involved, so they can never drift from the number on the tile.
//   • WHY and POTENTIAL IMPACT are generated in the BACKGROUND by the existing
//     Anthropic engine (lib/briefings/anthropic — same ANTHROPIC_API_KEY, no new
//     key), grounded ONLY in the real numbers. Narrative may be cached; the tile
//     FIGURES are always read live and are never stored (doctrine). When a metric
//     has no real driver to reason over, WHY/IMPACT fall back to an honest "Not
//     enough data yet" — the model is never asked to invent a cause.

import { anthropicMessages } from "@/lib/briefings/anthropic";
import { TIER_MODEL } from "@/lib/ai/models";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { loadMissionControl } from "@/lib/ceo/mission-control";
import { peso, pesoCompact, EMPTY } from "@/lib/metrics/format";
import type { MissionControl } from "@/lib/ceo/mission-control";

export type MetricKey =
  | "health"
  | "revenue"
  | "cash"
  | "cognition"
  | "revenuePulse"
  | "gmvPlatform";

export interface MetricBrief {
  key: MetricKey;
  label: string;
  what: string; // deterministic — the actual value
  how: string; // deterministic — the measurement source
  why: string; // AI (grounded) or an honest fallback
  impact: string; // AI (grounded) or an honest fallback
  grounded: boolean; // true only when why/impact came from the model on real data
}

// One metric's deterministic facts + the compact real-number context the model
// may reason over. `hasData` gates whether the model is asked at all.
interface MetricFact {
  key: MetricKey;
  label: string;
  what: string;
  how: string;
  context: string;
  hasData: boolean;
}

const NO_WHY = "Not enough data yet to identify a driver.";
const NO_IMPACT = "Not enough data yet to project an impact.";

// ── Deterministic WHAT / HOW / context, per metric ────────────────────────────
function buildFacts(mc: MissionControl, canSeeCash: boolean): MetricFact[] {
  const k = mc.kpis;
  const cur = k.currency;
  const facts: MetricFact[] = [];

  // Business Health
  facts.push({
    key: "health",
    label: "Business Health",
    what:
      k.health == null
        ? "No efficiency or quality signal on record yet, so Business Health is unscored."
        : `Business Health is ${k.health}/100.`,
    how: "Composite mean of the live operational signals (efficiency + quality) from metrics_snapshots.",
    context:
      k.health == null
        ? "Business Health: no signal (neither efficiency nor quality could be measured)."
        : `Business Health composite ${k.health}/100. Basis: ${k.healthBasis ?? "efficiency + quality"}.`,
    hasData: k.health != null,
  });

  // Revenue (windowed)
  facts.push({
    key: "revenue",
    label: `Revenue · ${k.windowLabel}`,
    what:
      k.revenueMtd == null
        ? `No commerce rows for ${k.windowLabel} yet.`
        : `Revenue for ${k.windowLabel} is ${peso(k.revenueMtd, cur)}${
            k.revenueDeltaPct != null && k.revenueDeltaLabel
              ? ` (${k.revenueDeltaPct >= 0 ? "+" : ""}${k.revenueDeltaPct}% ${k.revenueDeltaLabel})`
              : ""
          }.`,
    how: `Sum of live TikTok Shop GMV (tiktok_shop_performance) over ${k.windowLabel}, resolved in Asia/Manila.`,
    context:
      k.revenueMtd == null
        ? `Revenue (${k.windowLabel}): no commerce rows.`
        : `Revenue (${k.windowLabel}) = ${peso(k.revenueMtd, cur)}.` +
          (k.revenueDeltaPct != null && k.revenueDeltaLabel
            ? ` Change ${k.revenueDeltaPct}% ${k.revenueDeltaLabel}.`
            : " No comparable prior-window figure.") +
          (mc.platformSplit.hasData
            ? ` Top channel: ${mc.platformSplit.slices[0]?.label ?? "?"} at ${mc.platformSplit.slices[0]?.pct ?? 0}%.`
            : ""),
    hasData: k.revenueMtd != null,
  });

  // Cash Flow — ceo/coo only. Excluded entirely for every other role so its
  // existence is never signalled in the brief set.
  if (canSeeCash) {
    facts.push({
      key: "cash",
      label: "Cash Flow · 30d",
      what:
        k.cashFlow30d == null
          ? "No cash position is set, so 30-day cash flow can't be projected."
          : `Projected 30-day net cash flow is ${peso(k.cashFlow30d, cur)}, ending near ${peso(
              k.cashEndBalance ?? 0,
              cur
            )}.`,
      how: "Cash-flow forecast: the cash_positions anchor projected forward 30 days over live finance signals.",
      context:
        k.cashFlow30d == null
          ? "Cash Flow: no cash position set (cash_positions empty) — runway unknown."
          : `Cash Flow 30d net ${peso(k.cashFlow30d, cur)}; projected end balance ${peso(
              k.cashEndBalance ?? 0,
              cur
            )}${k.cashAsOf ? ` (anchored ${k.cashAsOf})` : ""}.`,
      hasData: k.cashFlow30d != null,
    });
  }

  // AI Cognition
  facts.push({
    key: "cognition",
    label: "AI Cognition",
    what:
      k.activeLoops == null
        ? "No proactive AI loops have run in the last 30 days."
        : `${k.activeLoops} active AI loop${k.activeLoops === 1 ? "" : "s"} in the last 30 days.`,
    how: "Count of distinct source_module values among action_requests drafted in the last 30 days.",
    context:
      k.activeLoops == null
        ? "AI Cognition: no proactive loops active."
        : `AI Cognition: ${k.activeLoops} active loop(s)${
            k.loopNames.length ? ` — ${k.loopNames.slice(0, 6).join(", ")}` : ""
          }.`,
    hasData: k.activeLoops != null,
  });

  // Revenue Pulse (12-week trend)
  const pulse = mc.revenuePulse;
  const pulseVals = pulse.points.map((p) => p.gmv);
  const last = pulseVals.length ? pulseVals[pulseVals.length - 1] : 0;
  facts.push({
    key: "revenuePulse",
    label: "Revenue Pulse",
    what: pulse.hasData
      ? `Weekly GMV across ${pulse.points.length} weeks; the latest week is ${pesoCompact(last, pulse.currency)}.`
      : "No commerce weeks recorded yet.",
    how: "Weekly GMV managed over the last 12 ISO weeks (Manila).",
    context: pulse.hasData
      ? `Revenue Pulse weekly GMV (oldest→newest): ${pulseVals
          .map((v) => Math.round(v))
          .join(", ")} ${pulse.currency}.`
      : "Revenue Pulse: no weekly commerce data.",
    hasData: pulse.hasData,
  });

  // GMV by Platform (windowed split)
  const split = mc.platformSplit;
  facts.push({
    key: "gmvPlatform",
    label: "GMV by Platform",
    what: split.hasData
      ? `Sales GMV of ${pesoCompact(split.totalGmv, split.currency)} split across ${
          split.slices.length
        } platform${split.slices.length === 1 ? "" : "s"}.`
      : `No platform GMV for ${split.windowLabel} yet.`,
    how: `Sales-channel share of GMV for ${split.windowLabel}.`,
    context: split.hasData
      ? `GMV by platform (${split.windowLabel}): ${split.slices
          .map((s) => `${s.label} ${s.pct}%`)
          .join(", ")}; total ${peso(split.totalGmv, split.currency)}.`
      : `GMV by Platform: no sales rows for ${split.windowLabel}.`,
    hasData: split.hasData,
  });

  return facts;
}

// ── AI WHY / IMPACT — the existing engine, cached ─────────────────────────────
type WhyImpact = { why: string; impact: string };

const SYSTEM_PROMPT =
  "You are the executive strategist for a Philippine TikTok Shop & Shopee agency. " +
  "For each metric you are given its real, current value and context. Explain WHY it is where it is, " +
  "and the POTENTIAL IMPACT if the current trajectory holds. Use ONLY the numbers and facts provided — " +
  "never invent a figure, cause, name, brand, or date. If the provided context does not contain enough to " +
  "identify a real driver, respond with exactly 'Not enough data yet.' for that field. Keep each field to a " +
  "single concise sentence. Respond ONLY as JSON of the form " +
  '{"<key>":{"why":"...","impact":"..."}} using the exact bracketed keys you are given, and nothing else.';

// Minimal, dependency-free JSON extraction (handles a ```json fence or stray prose).
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

// Bound the model call so a slow/hanging API never stalls the dashboard render.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("metric-briefs: model call timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// The raw model call — cached across requests by (metric contexts + model). Only
// metrics WITH real data are passed in, so the model never reasons over an empty
// figure. Returns a per-key {why, impact} map. A malformed response yields {}
// (a valid empty result worth caching); a network error / timeout THROWS so the
// failure is NOT cached — the next load retries, and loadMetricBriefs still
// renders honest fallbacks in the meantime.
async function callWhyImpact(payload: {
  model: string;
  metrics: { key: string; label: string; context: string }[];
}): Promise<Record<string, WhyImpact>> {
  if (payload.metrics.length === 0) return {};
  const user = payload.metrics
    .map((m) => `[${m.key}] ${m.label} — ${m.context}`)
    .join("\n");
  const text = await withTimeout(
    anthropicMessages({
      model: payload.model,
      system: SYSTEM_PROMPT,
      user,
      maxTokens: 900,
    }),
    12_000
  );
  const parsed = parseJson<Record<string, WhyImpact>>(text);
  return parsed ?? {};
}

// The cheapest tier. The prompt is "one sentence from six numbers" — Haiku is
// the right tool, and using Opus here previously burned the API budget.
const BRIEF_MODEL = TIER_MODEL.lite; // claude-haiku-4-5

// A minimal read client — only .from().select().eq() is used, so any Supabase
// server/service client satisfies it. Loosely typed (the DbShim style used across
// this codebase, e.g. AppShell) so the caller's fully-typed RLS-scoped client can
// be passed in without tripping the generated-Database deep-instantiation.
type BriefReadClient = { from: (table: string) => any };

// ── Public (RENDER): assemble the per-metric briefs from the CACHE only ───────
// This NEVER calls the model and NEVER awaits the network beyond one small,
// org-scoped select against metric_brief_cache. A metric with data but no cached
// blurb renders "—" instantly; a metric with no data keeps the honest
// "Not enough data yet." fallback. The tile FIGURES come from `mc` (live) — this
// only fills WHY / POTENTIAL IMPACT from the last background refresh.
export async function loadMetricBriefs(
  supabase: BriefReadClient,
  mc: MissionControl,
  opts: { role: string; canSeeCash: boolean; orgId: string }
): Promise<Partial<Record<MetricKey, MetricBrief>>> {
  const facts = buildFacts(mc, opts.canSeeCash);

  // Last-known blurbs for this org. A read failure is non-fatal: the page still
  // renders every figure live and shows "—" for the narrative. Bounded to ≤6
  // rows, org-scoped, RLS-filtered — a couple of milliseconds, never the model.
  const cache = new Map<string, WhyImpact>();
  try {
    const { data } = await supabase
      .from("metric_brief_cache")
      .select("metric_key, why, impact")
      .eq("org_id", opts.orgId);
    for (const row of (data ?? []) as { metric_key: string; why: string; impact: string }[]) {
      cache.set(row.metric_key, { why: row.why, impact: row.impact });
    }
  } catch {
    // fall through — every metric renders "—" for why/impact
  }

  const out: Partial<Record<MetricKey, MetricBrief>> = {};
  for (const f of facts) {
    let why: string;
    let impact: string;
    let grounded = false;
    if (!f.hasData) {
      why = NO_WHY;
      impact = NO_IMPACT;
    } else {
      const got = cache.get(f.key);
      if (got && (got.why?.trim() || got.impact?.trim())) {
        why = got.why?.trim() || EMPTY;
        impact = got.impact?.trim() || EMPTY;
        grounded = true;
      } else {
        // Data present, but the background refresh hasn't produced a blurb yet
        // (fresh deploy, or the API is rate-capped). Show "—" instantly — no
        // spinner, no wait — the figure above is still live.
        why = EMPTY;
        impact = EMPTY;
      }
    }
    out[f.key] = {
      key: f.key,
      label: f.label,
      what: f.what,
      how: f.how,
      why,
      impact,
      grounded,
    };
  }
  return out;
}

// ── Public (BACKGROUND): regenerate + persist the blurbs, off the request path ─
// Called by /api/automation/metric-briefs (the GitHub Actions scheduler), NEVER
// during render. Rebuilds Mission Control per org, asks the cheapest model for
// one grounded sentence per metric that HAS data, and upserts the result into
// metric_brief_cache. Writes with the service-role key (bypasses RLS). On a model
// failure (timeout / rate-cap) the org is skipped and its LAST cached blurbs
// stand — the dashboard keeps serving them (aging), never blocking. Emits ONE log
// line per org so a refresh is verifiable in runtime logs.
export async function refreshMetricBriefs(opts: {
  orgId?: string;
  nowMs?: number;
} = {}): Promise<{ orgs: number; written: number; failed: number }> {
  const svc = createServiceRoleClient();
  const nowMs = opts.nowMs ?? Date.now();

  let orgIds: string[];
  if (opts.orgId) {
    orgIds = [opts.orgId];
  } else {
    const { data } = await svc.from("organizations").select("id");
    orgIds = ((data ?? []) as { id: string }[]).map((r) => r.id).filter(Boolean);
  }

  let written = 0;
  let failed = 0;
  for (const orgId of orgIds) {
    try {
      // canSeeCash: true — the background job generates every metric's blurb
      // including cash; the render + RLS decide who may see the cash narrative.
      const mc = await loadMissionControl(
        svc as unknown as Parameters<typeof loadMissionControl>[0],
        orgId,
        { nowMs, windowKey: "mtd" }
      );
      const withData = buildFacts(mc, true).filter((f) => f.hasData);
      if (withData.length === 0) {
        console.info("[metric-briefs] refresh", { org: orgId, metrics: 0, status: "no-data" });
        continue;
      }

      const ai = await callWhyImpact({
        model: BRIEF_MODEL,
        metrics: withData.map((f) => ({ key: f.key, label: f.label, context: f.context })),
      });

      const rows = withData
        .map((f) => ({ f, got: ai[f.key] }))
        .filter(({ got }) => got && (got.why?.trim() || got.impact?.trim()))
        .map(({ f, got }) => ({
          org_id: orgId,
          metric_key: f.key,
          why: got!.why?.trim() || EMPTY,
          impact: got!.impact?.trim() || EMPTY,
          model: BRIEF_MODEL,
          refreshed_at: new Date(nowMs).toISOString(),
        }));

      if (rows.length > 0) {
        await (svc as unknown as {
          from: (t: string) => {
            upsert: (
              rows: unknown[],
              opts: { onConflict: string }
            ) => Promise<{ error: unknown }>;
          };
        })
          .from("metric_brief_cache")
          .upsert(rows, { onConflict: "org_id,metric_key" });
        written += rows.length;
      }
      console.info("[metric-briefs] refresh", {
        org: orgId,
        metrics: withData.length,
        written: rows.length,
        model: BRIEF_MODEL,
        status: "ok",
      });
    } catch (e) {
      // NON-BLOCKING and EXPECTED when the API is rate-capped or times out: the
      // dashboard keeps serving this org's LAST cached blurbs (aging), and every
      // figure is still live. Logged at WARN — this is graceful degradation by
      // design, not a render-path error. Emitted once per org per daily run.
      failed += 1;
      console.warn("[metric-briefs] refresh skipped (cache retained)", {
        org: orgId,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { orgs: orgIds.length, written, failed };
}
