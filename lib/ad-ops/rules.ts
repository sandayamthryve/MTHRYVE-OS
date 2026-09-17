// lib/ad-ops/rules.ts — Vesper's AD-OPS RULE ENGINE (pure, no I/O). Given one
// campaign's performance over the window, it decides whether to PROPOSE a
// pause (loser), a scale (winner, via a budget lift), or nothing. It never
// executes — it only produces a proposal that becomes an approval-gated
// action_request.
//
// HONEST DEGRADATION: the connected accounts don't all expose the same signals
// (Meta returns no conversions/ROAS; TikTok returns conversions but no ROAS).
// So the engine uses the STRONGEST signal available and states which one fired:
//   1. ROAS       — when a revenue-equivalent is present (best signal)
//   2. Conversions/CPA — when conversions are present (TikTok)
//   3. Clicks/CTR/CPC  — the efficiency floor everyone exposes
// A campaign below a minimum spend is ignored (too little signal to act on).
// Thresholds are conservative and env-overridable; every proposal carries the
// exact numbers that tripped it, so a human approver sees Vesper's reasoning.

import type { AdCampaignPerformance, AdChange, ProposedBudget } from "./types";

// One proposal for one campaign, or null when the campaign is in a healthy /
// insufficient-signal band and nothing should be drafted.
export interface AdProposal {
  change: Extract<AdChange, "pause" | "set_budget">;
  reason: string; // the signal that fired, in plain language
  signal: "roas" | "cpa" | "efficiency";
  budget?: ProposedBudget; // present for set_budget (scale)
  // The single fact that most strongly justifies the change, for the card.
  headline: string;
}

export interface AdRuleThresholds {
  minSpend: number; // ignore campaigns spending less than this over the window
  windowDays: number; // days in the window (to derive a daily budget from spend)
  scaleRoas: number; // ROAS at/above which a campaign is a winner
  pauseRoas: number; // ROAS at/below which a campaign is a loser
  targetCpa: number; // CPA at/below which a campaign is a winner (conversion signal)
  maxCpa: number; // CPA at/above which a campaign is a loser (conversion signal)
  goodCtr: number; // CTR% at/above which efficiency looks healthy
  scaleFactor: number; // budget multiple applied to recent daily spend on a scale
}

// Defaults tuned to be cautious — money changes are gated anyway, but we'd
// rather under-propose than spam the queue. Currency-valued ones assume PHP.
export const DEFAULT_THRESHOLDS: AdRuleThresholds = {
  minSpend: 500,
  windowDays: 7,
  scaleRoas: 2.0,
  pauseRoas: 0.8,
  targetCpa: 150,
  maxCpa: 600,
  goodCtr: 1.5,
  scaleFactor: 1.2,
};

// Read thresholds from env (WINDSOR_ADOPS_*), falling back to the defaults.
export function thresholdsFromEnv(windowDays: number): AdRuleThresholds {
  const n = (key: string, dflt: number): number => {
    const raw = process.env[key]?.trim();
    if (!raw) return dflt;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    minSpend: n("WINDSOR_ADOPS_MIN_SPEND", DEFAULT_THRESHOLDS.minSpend),
    windowDays,
    scaleRoas: n("WINDSOR_ADOPS_SCALE_ROAS", DEFAULT_THRESHOLDS.scaleRoas),
    pauseRoas: n("WINDSOR_ADOPS_PAUSE_ROAS", DEFAULT_THRESHOLDS.pauseRoas),
    targetCpa: n("WINDSOR_ADOPS_TARGET_CPA", DEFAULT_THRESHOLDS.targetCpa),
    maxCpa: n("WINDSOR_ADOPS_MAX_CPA", DEFAULT_THRESHOLDS.maxCpa),
    goodCtr: n("WINDSOR_ADOPS_GOOD_CTR", DEFAULT_THRESHOLDS.goodCtr),
    scaleFactor: n("WINDSOR_ADOPS_SCALE_FACTOR", DEFAULT_THRESHOLDS.scaleFactor),
  };
}

// The daily budget a scale would propose: recent daily spend × scaleFactor,
// rounded to a whole currency unit and floored at 1 so it's always positive.
function proposedDailyBudget(spend: number, t: AdRuleThresholds, currency: string): ProposedBudget {
  const dailySpend = spend / Math.max(1, t.windowDays);
  const amount = Math.max(1, Math.round(dailySpend * t.scaleFactor));
  return { amount, currency, kind: "daily" };
}

// Evaluate one campaign. Returns a single proposal (the strongest signal) or
// null. Order of precedence: ROAS → CPA → efficiency; within each, a clear
// loser (pause) or a clear winner (scale). Middling bands return null.
export function evaluateCampaign(
  perf: AdCampaignPerformance,
  t: AdRuleThresholds
): AdProposal | null {
  const spend = perf.spend ?? 0;
  if (spend < t.minSpend) return null; // too little signal to act on

  const currency = perf.currency;

  // 1) ROAS signal (best) — only when revenue was available.
  if (perf.roas != null) {
    if (perf.roas <= t.pauseRoas) {
      return {
        change: "pause",
        signal: "roas",
        reason: `ROAS ${perf.roas}× over the window is at/below the ${t.pauseRoas}× floor on ${money(spend, currency)} spend — the campaign is losing money.`,
        headline: `ROAS ${perf.roas}× ≤ ${t.pauseRoas}× floor`,
      };
    }
    if (perf.roas >= t.scaleRoas) {
      return {
        change: "set_budget",
        signal: "roas",
        reason: `ROAS ${perf.roas}× is at/above the ${t.scaleRoas}× bar on ${money(spend, currency)} spend — a winner worth scaling.`,
        headline: `ROAS ${perf.roas}× ≥ ${t.scaleRoas}× bar`,
        budget: proposedDailyBudget(spend, t, currency),
      };
    }
    return null; // healthy-but-not-exceptional
  }

  // 2) Conversion / CPA signal (TikTok exposes conversions).
  if (perf.conversions != null) {
    if (perf.conversions === 0) {
      return {
        change: "pause",
        signal: "cpa",
        reason: `No conversions on ${money(spend, currency)} spend over the window — the campaign is spending without converting.`,
        headline: `0 conversions on ${money(spend, currency)}`,
      };
    }
    const cpa = round(spend / perf.conversions, 2);
    if (cpa >= t.maxCpa) {
      return {
        change: "pause",
        signal: "cpa",
        reason: `CPA ${money(cpa, currency)} (${perf.conversions} conv on ${money(spend, currency)}) is at/above the ${money(t.maxCpa, currency)} ceiling — too expensive to keep running.`,
        headline: `CPA ${money(cpa, currency)} ≥ ${money(t.maxCpa, currency)} ceiling`,
      };
    }
    if (cpa <= t.targetCpa) {
      return {
        change: "set_budget",
        signal: "cpa",
        reason: `CPA ${money(cpa, currency)} (${perf.conversions} conv on ${money(spend, currency)}) is at/below the ${money(t.targetCpa, currency)} target — an efficient winner worth scaling.`,
        headline: `CPA ${money(cpa, currency)} ≤ ${money(t.targetCpa, currency)} target`,
        budget: proposedDailyBudget(spend, t, currency),
      };
    }
    return null;
  }

  // 3) Efficiency floor (clicks / CTR) — the only signal Meta exposes here.
  //    A campaign spending real money with ZERO clicks is a clear loser; we do
  //    NOT scale on clicks/CTR alone (too weak a signal to justify more spend).
  if (perf.clicks != null && perf.clicks === 0) {
    return {
      change: "pause",
      signal: "efficiency",
      reason: `Zero clicks on ${money(spend, currency)} spend over the window — the campaign is spending with no engagement.`,
      headline: `0 clicks on ${money(spend, currency)}`,
    };
  }

  return null;
}

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
