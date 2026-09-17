// lib/security/events.ts — the two recorders the anomaly monitor reads from
// (PASTE 4.3 Part D).
//
//   • recordAiUsage       → public.ai_usage_log  (per-call model + tokens + $ est)
//   • recordSecurityEvent → public.security_events (failed logins, RLS denials,
//                            data exports, mass reads — the security signal feed)
//
// Both are BEST-EFFORT: recording a signal must never break the request it
// describes (mirrors lib/actions/audit.ts). They write through whatever client
// the caller hands in — the service-role client for system paths (cron, workers)
// or the caller's RLS client on a request path — using the same cast shim the
// rest of the newer OS surfaces use, because these tables aren't in the generated
// Database types yet.

import { tierForModel, type ModelTier } from "@/lib/ai/models";

type Shim = { from: (t: string) => any };

// ── AI usage / spend ─────────────────────────────────────────────────────────

// Approximate Anthropic list prices (USD per 1M tokens), by tier. Kept here as a
// single, honest, editable estimate — the money-gate and real billing live
// elsewhere; this is only to give the spend-spike detector a comparable $ figure.
const TIER_USD_PER_MTOK: Record<ModelTier, { input: number; output: number }> = {
  lite: { input: 1, output: 5 }, // Haiku 4.5
  standard: { input: 3, output: 15 }, // Sonnet 5
  premium: { input: 15, output: 75 }, // Opus 4.8
};

/** Estimate the USD cost of one AI call from its model + token counts. */
export function estimateCostUsd(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number
): number {
  const tier = tierForModel(model) ?? "standard";
  const rate = TIER_USD_PER_MTOK[tier];
  const usd = (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
  return Math.round(usd * 1_000_000) / 1_000_000; // 6dp of a dollar
}

export interface AiUsageInput {
  orgId: string;
  userId?: string | null;
  /**
   * Which feature made the call — the `feature` text column on ai_usage_log:
   * 'tony' | 'vesper' | 'vesper_reach' | 'quick_entry_vision' | 'csi' | ...
   */
  feature: string;
  model: string | null | undefined;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Record one AI call's usage + estimated USD cost into public.ai_usage_log.
 *
 * Best-effort — it must never break the request it describes, so it never
 * re-throws. But a failure is now LOGGED rather than silently swallowed: a
 * bad column, RLS denial, or transport error surfaces in the server logs
 * instead of quietly dropping every row (which is exactly how a column-name
 * mismatch went unnoticed until ai_usage_log was found empty).
 *
 * The columns written are the REAL ai_usage_log columns and nothing else:
 * org_id, user_id, feature, model, input_tokens, output_tokens, est_cost_usd.
 * Missing token counts are stored as 0 (the detector works on relative spikes,
 * so an occasional gap doesn't distort it).
 */
export async function recordAiUsage(db: unknown, input: AiUsageInput): Promise<void> {
  const inTok = Math.max(0, Math.round(Number(input.inputTokens ?? 0)) || 0);
  const outTok = Math.max(0, Math.round(Number(input.outputTokens ?? 0)) || 0);
  try {
    const { error } = await (db as Shim).from("ai_usage_log").insert({
      org_id: input.orgId,
      user_id: input.userId ?? null,
      feature: input.feature,
      model: input.model ?? null,
      input_tokens: inTok,
      output_tokens: outTok,
      est_cost_usd: estimateCostUsd(input.model, inTok, outTok),
    });
    // Supabase surfaces write failures in `error`, not as a throw — so an empty
    // catch would hide them entirely. Log it (never re-throw) so it's visible.
    if (error) {
      console.error("[recordAiUsage] ai_usage_log insert failed", {
        feature: input.feature,
        code: (error as { code?: string }).code,
        message: (error as { message?: string }).message,
      });
    }
  } catch (err) {
    // A thrown client/network error still must not break the caller's request.
    console.error("[recordAiUsage] ai_usage_log insert threw", err);
  }
}

// ── Security events ──────────────────────────────────────────────────────────

// The security signal types the anomaly monitor understands. Add a type here +
// emit it and the detector can flag a surge on it.
export type SecurityEventType =
  | "failed_login"
  | "rls_denial"
  | "data_export"
  | "mass_read"
  | "injection_flagged"
  | "output_redacted";

export type SecuritySeverity = "info" | "warning" | "critical";

export interface SecurityEventInput {
  orgId: string;
  userId?: string | null;
  eventType: SecurityEventType;
  severity?: SecuritySeverity;
  /** Attempted identity when there is no session yet (e.g. failed login email). */
  subject?: string | null;
  ip?: string | null;
  /** Small, non-sensitive detail (row counts, tool name, matched labels…). */
  detail?: Record<string, unknown> | null;
}

/**
 * Record one security-relevant event. Never throws. `severity` defaults to
 * 'warning'. The row is the raw signal; turning many rows into an ALERT is the
 * anomaly monitor's job.
 */
export async function recordSecurityEvent(db: unknown, input: SecurityEventInput): Promise<void> {
  try {
    await (db as Shim).from("security_events").insert({
      org_id: input.orgId,
      user_id: input.userId ?? null,
      event_type: input.eventType,
      severity: input.severity ?? "warning",
      subject: input.subject ?? null,
      ip: input.ip ?? null,
      detail: input.detail ?? null,
    });
  } catch {
    // best-effort signal.
  }
}
