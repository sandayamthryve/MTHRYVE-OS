// HeyGen cost estimation — the numbers behind the MANDATORY cost-preview +
// approval gate. HeyGen bills real money per rendered video, so no submit ever
// happens without a human seeing an estimate and clicking Approve. This module
// is the SINGLE source of that math, imported by both the client preview (live,
// as the user edits the script) and the server action (authoritative recompute
// before insert) so the two can never disagree.
//
// The estimate is duration × per-minute rate:
//   • duration is inferred from the script's word count at an average avatar
//     speaking pace (~140 wpm), floored at a few seconds so a tiny script still
//     reads as non-zero.
//   • the rate depends on the avatar tier the user selects. HeyGen's own
//     guidance: Avatar III ≈ $1/min, Avatar IV ≈ $3–5/min. We take the upper
//     end of each band so the preview never UNDER-states what may be spent.

// Average words per minute a HeyGen avatar speaks. Used to turn a script into an
// estimated runtime. Conservative-ish (slower pace → longer video → higher, not
// lower, cost estimate).
export const WORDS_PER_MINUTE = 140;

// Never estimate below this — even a one-line script renders a short clip.
export const MIN_DURATION_SECONDS = 8;

// Avatar tiers the user can pick, each with the per-minute USD rate we bill the
// preview against. We use the top of HeyGen's quoted bands so the shown estimate
// is the worst case, not a rosy one.
export type AvatarTier = "avatar_iii" | "avatar_iv";

export interface TierInfo {
  id: AvatarTier;
  label: string;
  ratePerMinuteUsd: number;
  hint: string;
}

export const AVATAR_TIERS: Record<AvatarTier, TierInfo> = {
  avatar_iii: {
    id: "avatar_iii",
    label: "Avatar III",
    ratePerMinuteUsd: 1,
    hint: "≈ $1 / min",
  },
  avatar_iv: {
    id: "avatar_iv",
    label: "Avatar IV",
    ratePerMinuteUsd: 5,
    hint: "≈ $3–5 / min (billed at the $5 ceiling)",
  },
};

export const DEFAULT_TIER: AvatarTier = "avatar_iii";

// Coerce an untrusted string into a known tier (defaults to Avatar III). Used
// server-side so a tampered form value can only ever pick a real, priced tier.
export function coerceTier(v: unknown): AvatarTier {
  return v === "avatar_iv" ? "avatar_iv" : "avatar_iii";
}

// Count words in a script (whitespace-delimited, empties dropped).
export function countWords(script: string): number {
  const t = script.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

// Estimated spoken duration of a script, in seconds, floored at MIN_DURATION.
export function estimateDurationSeconds(script: string): number {
  const words = countWords(script);
  if (words === 0) return 0;
  const seconds = (words / WORDS_PER_MINUTE) * 60;
  return Math.max(MIN_DURATION_SECONDS, Math.round(seconds));
}

// Estimated USD cost = minutes × tier rate, rounded to cents. Zero for an empty
// script (nothing to render → nothing to preview).
export function estimateCostUsd(script: string, tier: AvatarTier): number {
  const seconds = estimateDurationSeconds(script);
  if (seconds === 0) return 0;
  const minutes = seconds / 60;
  const rate = AVATAR_TIERS[tier].ratePerMinuteUsd;
  return Math.round(minutes * rate * 100) / 100;
}

// Actual USD cost once HeyGen reports a real duration on completion. Same
// per-minute rate, applied to the true runtime.
export function actualCostUsd(durationSeconds: number, tier: AvatarTier): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const minutes = durationSeconds / 60;
  const rate = AVATAR_TIERS[tier].ratePerMinuteUsd;
  return Math.round(minutes * rate * 100) / 100;
}

// Reconstruct the per-minute rate that produced a stored estimate, without a
// dedicated tier column: rate = estimated_cost ÷ estimated_minutes, where the
// estimated minutes are recomputed from the SAME stored script the estimate was
// built from. Used on completion to price the real runtime at the rate the
// approver actually saw and approved. Falls back to the default tier's rate when
// the estimate/script can't reproduce a sane rate.
export function deriveRatePerMinuteUsd(
  script: string,
  estimatedCostUsd: number | null
): number {
  const fallback = AVATAR_TIERS[DEFAULT_TIER].ratePerMinuteUsd;
  if (estimatedCostUsd == null || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd <= 0) {
    return fallback;
  }
  const minutes = estimateDurationSeconds(script) / 60;
  if (minutes <= 0) return fallback;
  const rate = estimatedCostUsd / minutes;
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

// Actual USD cost from a real runtime and an explicit per-minute rate.
export function actualCostFromRate(durationSeconds: number, ratePerMinuteUsd: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.round((durationSeconds / 60) * ratePerMinuteUsd * 100) / 100;
}

// Format a USD amount for display. null → an em dash.
export function formatUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}
