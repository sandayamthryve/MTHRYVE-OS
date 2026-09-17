// lib/policy/registry.ts — the policy consult layer for consequential saves.
//
// public.policy_registry (migration 20260716010000) is the org's map of "what
// rule governs a consequential save". This module is the ONE place the app reads
// it, so the mobile quick-entry UI and the server save route never disagree on
// the rule. It is dependency-light (types + pure helpers + a shim-based read),
// so both the client wizard and the server route import it safely.
//
// Governing intent: vision output is a SUGGESTION. A capture save must be
// human-confirmed and never auto-commits; a typed value that diverges from the
// machine reading past the policy threshold is FLAGGED for review (the
// metric-mismatch idea, applied at capture time).

// The policy shape the app cares about. Extra knobs live in `config` (jsonb).
export interface CapturePolicy {
  key: string;
  requires_confirmation: boolean;
  allow_auto_save: boolean;
  divergence_threshold_pct: number;
  enabled: boolean;
  /** true when this came from a real policy_registry row; false = safe default. */
  resolved: boolean;
}

// The safe default used when policy_registry has no row yet (or the read fails).
// It is the STRICTEST honest posture: a human must confirm, nothing auto-saves,
// and a 10% divergence flags. Consulting policy can only ever ADD guardrails, so
// falling back to this default never weakens the rule.
export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  key: "evidence_capture",
  requires_confirmation: true,
  allow_auto_save: false,
  divergence_threshold_pct: 10,
  enabled: true,
  resolved: false,
};

// Minimal cast shim on the caller's RLS client — policy_registry is provisioned
// out of band (like skill_registry / capabilities), so it isn't in the generated
// Database types. Every read goes through the RLS client, org-scoped by policy.
type PolicyDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (col: string, v: string) => {
        eq: (col: string, v: string) => {
          maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
};

interface PolicyRow {
  key?: string;
  requires_confirmation?: boolean;
  allow_auto_save?: boolean;
  divergence_threshold_pct?: number | string;
  enabled?: boolean;
}

// Consult the policy governing a consequential save. Reads the org's
// policy_registry row for `key` on the RLS client; returns the strict default if
// there is no row (honest, never weaker than the default). Best-effort: any read
// failure falls back to the default rather than blocking the request path from
// even consulting.
export async function consultPolicy(
  db: unknown,
  key = "evidence_capture"
): Promise<CapturePolicy> {
  try {
    const client = db as PolicyDb;
    const { data } = await client
      .from("policy_registry")
      .select("key, requires_confirmation, allow_auto_save, divergence_threshold_pct, enabled")
      .eq("key", key)
      .eq("enabled", true as unknown as string)
      .maybeSingle();

    const row = data as PolicyRow | null;
    if (!row) return { ...DEFAULT_CAPTURE_POLICY, key };

    const threshold = Number(row.divergence_threshold_pct);
    return {
      key: row.key ?? key,
      // A policy can only tighten: a missing/false confirmation flag still
      // requires confirmation, and auto-save stays off unless explicitly allowed.
      requires_confirmation: row.requires_confirmation !== false,
      allow_auto_save: row.allow_auto_save === true,
      divergence_threshold_pct:
        Number.isFinite(threshold) && threshold > 0
          ? threshold
          : DEFAULT_CAPTURE_POLICY.divergence_threshold_pct,
      enabled: row.enabled !== false,
      resolved: true,
    };
  } catch {
    return { ...DEFAULT_CAPTURE_POLICY, key };
  }
}

// Divergence between the human-typed value and the machine reading, as a percent
// of the machine reading. Mirrors metric_entries.variance_pct
// (abs(a - b) / abs(b) * 100). Returns null when it can't be computed honestly
// (either side missing, or the machine read 0 — no meaningful base).
export function divergencePct(
  typed: number | null | undefined,
  extracted: number | null | undefined
): number | null {
  if (typed == null || extracted == null) return null;
  if (!Number.isFinite(typed) || !Number.isFinite(extracted)) return null;
  if (extracted === 0) return null;
  return Math.round((Math.abs(typed - extracted) / Math.abs(extracted)) * 100 * 100) / 100;
}

// Whether a typed/extracted pair should be FLAGGED under a policy. A pair we
// can't compare (divergencePct → null) is never flagged — honest, not a guess.
export function isDivergenceFlagged(
  typed: number | null | undefined,
  extracted: number | null | undefined,
  policy: CapturePolicy
): boolean {
  const pct = divergencePct(typed, extracted);
  if (pct == null) return false;
  return pct > policy.divergence_threshold_pct;
}
