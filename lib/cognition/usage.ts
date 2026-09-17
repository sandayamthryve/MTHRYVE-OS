// lib/cognition/usage.ts — logs the Cognition Loop's Claude call to
// public.ai_usage_log with feature='cognition_loop'.
//
// It writes the REAL columns the live ai_usage_log table exposes
// (org_id, feature, model, input_tokens, output_tokens, est_cost_usd, user_id).
// Best-effort, exactly like lib/actions/audit.ts: recording spend must never
// break the loop it measures. The RLS insert policy only requires
// org_id = current_org_id(), so the caller's own RLS client can write it.

import type { AnthropicUsage } from "@/lib/briefings/anthropic";

type Shim = { from: (t: string) => any };

// Anthropic list prices (USD per 1M tokens), by model id — kept next to the
// logger so the per-call $ estimate is honest and editable. Mirrors the figures
// used by the vision route. An unknown model estimates 0 (never a wrong number).
const USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 15, output: 75 },
};

function estCostUsd(model: string, inTok: number, outTok: number): number | null {
  const price = USD_PER_MTOK[model];
  if (!price) return null;
  const usd = (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export async function logCognitionUsage(
  db: Shim,
  input: {
    orgId: string;
    userId: string | null;
    model: string;
    usage: AnthropicUsage;
    // The ai_usage_log feature tag. Defaults to the base loop; the Executive
    // Council overrides it with 'council:<member key>' so per-officer spend is
    // attributable without a second logger.
    feature?: string;
  }
): Promise<void> {
  try {
    const inTok = Math.max(0, Math.round(input.usage.inputTokens) || 0);
    const outTok = Math.max(0, Math.round(input.usage.outputTokens) || 0);
    await db.from("ai_usage_log").insert({
      org_id: input.orgId,
      user_id: input.userId,
      feature: input.feature ?? "cognition_loop",
      model: input.model,
      input_tokens: inTok,
      output_tokens: outTok,
      est_cost_usd: estCostUsd(input.model, inTok, outTok),
    });
  } catch {
    // Spend logging is a signal, never a gate — swallow.
  }
}
