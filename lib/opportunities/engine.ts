// lib/opportunities/engine.ts — the wire contract with the Opportunity Engine
// webhook, plus a defensive normalizer for whatever it returns.
//
// The OS POSTs { criteria, candidates } to the engine (an GitHub Actions / external
// workflow whose URL comes from the automation_registry — never a constant) and
// gets back a RANKED list: each candidate with a tier (HOT / WARM / COLD), a
// numeric score, and a plain-language reason. This module owns ONLY the request/
// response shaping and the fetch; it stages nothing and calls no DB — that is the
// gateway's job (lib/opportunities/gateway.ts). Nothing here reaches a prospect.
//
// The engine is external and its exact JSON may drift, so the normalizer accepts
// several reasonable shapes and degrades unknown fields to safe defaults rather
// than throwing.

import type { OpportunityCandidate } from "./csv";

// The criteria a human sets on the panel to steer ranking. Everything is
// optional — an empty criteria object just asks the engine to rank on its own
// judgement. `prioritize` flags say "these signals matter to us right now".
export interface OpportunityCriteria {
  focus_category: string | null;
  min_monthly_revenue: number | null;
  prioritize: {
    sells_online: boolean;
    has_tiktok_shop: boolean;
    gmv_declining: boolean;
    runs_ads: boolean;
  };
}

export type OpportunityTier = "HOT" | "WARM" | "COLD";

// One ranked result as we present it. `candidate` carries the original prospect
// fields (matched back by name) so the panel can show revenue/category next to
// the verdict without trusting the engine to echo them. `staged` / `stagedRef`
// are set when the engine's own gateway already staged this HOT one, so our
// gateway knows not to double-stage.
export interface RankedOpportunity {
  name: string;
  tier: OpportunityTier;
  score: number; // 0..100
  reason: string;
  candidate: OpportunityCandidate | null;
  staged: boolean;
  stagedRef: string | null; // an action_request id the engine reports, if any
}

// A stable key for a candidate/result — lowercased, collapsed-whitespace name.
// Used to match engine results back to input candidates and to dedupe staging.
export function candidateKey(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Coerce an arbitrary tier value to our three-tier vocabulary. Unknown → COLD
// (the safe, no-action bucket) so a shape drift never accidentally stages.
export function normalizeTier(raw: unknown): OpportunityTier {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t === "hot") return "HOT";
  if (t === "warm") return "WARM";
  if (t === "cold") return "COLD";
  return "COLD";
}

// Coerce a score to an integer in [0, 100]. Accepts 0..1 fractions (multiplied
// up) and 0..100 values alike; non-numeric → 0.
export function normalizeScore(raw: unknown): number {
  let n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) n = n * 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

type LooseResult = Record<string, unknown>;

// Pull the results array out of whatever envelope the engine used: a bare array,
// { results: [...] }, or { opportunities: [...] }.
function extractResultArray(body: unknown): LooseResult[] {
  if (Array.isArray(body)) return body as LooseResult[];
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ["results", "opportunities", "ranked", "data"]) {
      if (Array.isArray(obj[key])) return obj[key] as LooseResult[];
    }
  }
  return [];
}

// Normalize the engine's raw response into RankedOpportunity[], matched back to
// the candidates we sent so the panel can show original fields. Results whose
// name doesn't match any candidate are still shown (candidate: null) — the engine
// is authoritative on ranking, we just can't enrich them.
export function normalizeEngineResponse(
  body: unknown,
  candidates: OpportunityCandidate[]
): RankedOpportunity[] {
  const byKey = new Map(candidates.map((c) => [candidateKey(c.name), c]));
  const rows = extractResultArray(body);

  const out: RankedOpportunity[] = [];
  for (const r of rows) {
    const name = String(r.name ?? r.candidate ?? r.prospect ?? "").trim();
    if (!name) continue;
    const key = candidateKey(name);
    const reason = String(r.reason ?? r.rationale ?? r.explanation ?? "").trim();
    const stagedRef =
      (r.action_request_id as string | undefined) ??
      (r.staged_ref as string | undefined) ??
      null;
    out.push({
      name,
      tier: normalizeTier(r.tier ?? r.rank ?? r.bucket),
      score: normalizeScore(r.score ?? r.rating ?? r.points),
      reason: reason || "No reason provided by the engine.",
      candidate: byKey.get(key) ?? null,
      staged: r.staged === true || Boolean(stagedRef),
      stagedRef,
    });
  }

  // Rank the display: HOT → WARM → COLD, then by score desc, then name.
  const tierRank: Record<OpportunityTier, number> = { HOT: 0, WARM: 1, COLD: 2 };
  out.sort(
    (a, b) => tierRank[a.tier] - tierRank[b.tier] || b.score - a.score || a.name.localeCompare(b.name)
  );
  return out;
}

export interface EngineCallResult {
  ok: boolean;
  status: number;
  results: RankedOpportunity[];
  error?: string;
}

// POST { criteria, candidates } to the engine webhook and return normalized
// results. The URL is passed in (read from the registry by the caller) — this
// function never knows a constant. Network / non-2xx / bad-JSON failures are
// caught and returned as { ok:false, error } rather than thrown, so the panel can
// show a calm message. A 20s timeout keeps a hung webhook from hanging the action.
export async function callOpportunityEngine(
  webhookUrl: string,
  payload: { criteria: OpportunityCriteria; candidates: OpportunityCandidate[] }
): Promise<EngineCallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });
    const status = res.status;
    if (!res.ok) {
      return { ok: false, status, results: [], error: `Engine responded ${status}.` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, status, results: [], error: "Engine returned a non-JSON response." };
    }
    return { ok: true, status, results: normalizeEngineResponse(body, payload.candidates) };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      results: [],
      error: aborted ? "Engine timed out (20s)." : "Could not reach the Opportunity Engine.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
