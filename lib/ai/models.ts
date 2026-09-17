// AI model tiers (DECISIONS.md D-012). Three Anthropic tiers, gated by role +
// per-task grants. Shared by the assistant route (server) and the chat UI, so
// keep this dependency-free.
export type ModelTier = "lite" | "standard" | "premium";

export const MODEL_TIERS: ModelTier[] = ["lite", "standard", "premium"];

export const TIER_ORDER: Record<ModelTier, number> = {
  lite: 0,
  standard: 1,
  premium: 2,
};

// Confirmed against the Anthropic models docs (July 2026): Haiku 4.5 /
// Sonnet 5 / Opus 4.8. Each is a pinned snapshot.
export const TIER_MODEL: Record<ModelTier, string> = {
  lite: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  premium: "claude-opus-4-8",
};

export const TIER_LABEL: Record<ModelTier, string> = {
  lite: "Haiku · lite",
  standard: "Sonnet · standard",
  premium: "Opus · premium",
};

// Reverse of TIER_MODEL: map a stored model id back to its tier (for showing
// which model answered a historical message). Unknown ids resolve to null.
export function tierForModel(model: string | null | undefined): ModelTier | null {
  if (!model) return null;
  const hit = MODEL_TIERS.find((t) => TIER_MODEL[t] === model);
  return hit ?? null;
}

const ROLE_DEFAULT_TIER: Record<string, ModelTier> = {
  team_member: "lite",
  department_head: "standard",
  ceo: "premium",
  coo: "premium",
};

// The tier a role gets by default (and the ceiling it can use without a grant).
export function defaultTierFor(role: string): ModelTier {
  return ROLE_DEFAULT_TIER[role] ?? "lite";
}

export function isModelTier(v: unknown): v is ModelTier {
  return v === "lite" || v === "standard" || v === "premium";
}

// Tiers a role may use with no grant: its default and everything below it.
export function tiersWithinDefault(role: string): ModelTier[] {
  const d = defaultTierFor(role);
  return MODEL_TIERS.filter((t) => TIER_ORDER[t] <= TIER_ORDER[d]);
}
