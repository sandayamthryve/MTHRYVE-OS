// Tony's Personality Dial (TARS-style). Per-user tone controls that shape HOW
// Tony phrases a grounded answer — never WHAT is true. Four 0..100 sliders drive
// a TONE MODIFIER that is prepended to the assistant system prompt on every
// grounded call; the same HARD RULE that pins "delivery only" is baked into that
// prompt AND shown under the sliders in the UI.
//
// Kept dependency-free (no supabase import in the pure section) so it can be
// shared by the server route and the client panel. The one loader at the bottom
// takes a client the caller already has.
//
// The backing table `assistant_settings` (org_id, user_id unique) is RLS-scoped
// so a user only ever reads/writes their own row; new users get the Operator
// preset (the column defaults mirror it, and we fall back to it in code too).

export type ToneSettings = {
  preset: TonePreset;
  directness: number; // 0 gentle .. 100 blunt
  warmth: number; // 0 cool .. 100 warm
  humor: number; // 0 serious .. 100 playful
  brevity: number; // 0 detailed .. 100 terse
};

export type ToneDimension = "directness" | "warmth" | "humor" | "brevity";

export const TONE_DIMENSIONS: {
  key: ToneDimension;
  label: string;
  low: string; // label for the 0 end
  high: string; // label for the 100 end
  hint: string;
}[] = [
  {
    key: "directness",
    label: "Directness",
    low: "Gentle",
    high: "Blunt",
    hint: "How straight Tony gets to the point.",
  },
  {
    key: "warmth",
    label: "Warmth",
    low: "Cool",
    high: "Warm",
    hint: "How personable vs. matter-of-fact.",
  },
  {
    key: "humor",
    label: "Humor",
    low: "Serious",
    high: "Playful",
    hint: "How much dry wit is welcome.",
  },
  {
    key: "brevity",
    label: "Brevity",
    low: "Detailed",
    high: "Terse",
    hint: "How much Tony says to get there.",
  },
];

export type TonePreset = "operator" | "coach" | "concise" | "detailed" | "custom";

// Fixed preset values. Operator is the default for new users (mirrors the DB
// column defaults). "custom" carries no fixed values — it just marks that the
// user has hand-tuned the sliders away from any named preset.
export const TONE_PRESETS: {
  key: Exclude<TonePreset, "custom">;
  label: string;
  blurb: string;
  values: Omit<ToneSettings, "preset">;
}[] = [
  {
    key: "operator",
    label: "Operator",
    blurb: "Blunt, brief, a little warmth. The default.",
    values: { directness: 80, warmth: 60, humor: 20, brevity: 70 },
  },
  {
    key: "coach",
    label: "Coach",
    blurb: "Warm and encouraging, takes time to explain.",
    values: { directness: 45, warmth: 90, humor: 35, brevity: 25 },
  },
  {
    key: "concise",
    label: "Concise",
    blurb: "Fewest words. Answer first, no filler.",
    values: { directness: 85, warmth: 35, humor: 10, brevity: 95 },
  },
  {
    key: "detailed",
    label: "Detailed",
    blurb: "Thorough context and reasoning, even-keeled.",
    values: { directness: 55, warmth: 60, humor: 20, brevity: 10 },
  },
];

export const DEFAULT_TONE: ToneSettings = {
  preset: "operator",
  ...TONE_PRESETS[0].values,
};

// The non-negotiable contract, verbatim in both the system prompt and the UI.
export const TONE_HARD_RULE =
  "HARD RULE — the personality dial changes DELIVERY ONLY: the wording, tone, " +
  "and length of your answer. It must NEVER change the facts, the numbers, the " +
  "tool results, or your willingness to surface bad news. If the honest answer " +
  "is unwelcome, still give it — just in the requested tone. Never soften, " +
  "inflate, omit, or bend a fact to fit the tone.";

// The short version shown under the sliders.
export const TONE_UI_NOTE = "Changes how Tony talks, not what's true.";

function clamp(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

// Normalize a raw DB row (or anything shaped like one) into ToneSettings,
// falling back to the Operator default for missing/invalid fields.
export function normalizeTone(row: Partial<ToneSettings> | null | undefined): ToneSettings {
  if (!row) return { ...DEFAULT_TONE };
  const preset = isTonePreset(row.preset) ? row.preset : "custom";
  return {
    preset,
    directness: row.directness == null ? DEFAULT_TONE.directness : clamp(row.directness),
    warmth: row.warmth == null ? DEFAULT_TONE.warmth : clamp(row.warmth),
    humor: row.humor == null ? DEFAULT_TONE.humor : clamp(row.humor),
    brevity: row.brevity == null ? DEFAULT_TONE.brevity : clamp(row.brevity),
  };
}

export function isTonePreset(v: unknown): v is TonePreset {
  return (
    v === "operator" ||
    v === "coach" ||
    v === "concise" ||
    v === "detailed" ||
    v === "custom"
  );
}

// Which named preset (if any) a set of slider values exactly matches. Used by
// the UI to light up the active preset and to stamp `preset` on save.
export function matchPreset(values: Omit<ToneSettings, "preset">): TonePreset {
  const hit = TONE_PRESETS.find(
    (p) =>
      p.values.directness === values.directness &&
      p.values.warmth === values.warmth &&
      p.values.humor === values.humor &&
      p.values.brevity === values.brevity
  );
  return hit ? hit.key : "custom";
}

type Band = "low" | "mid" | "high";
function band(v: number): Band {
  if (v <= 33) return "low";
  if (v >= 67) return "high";
  return "mid";
}

// Per-dimension phrasing. Empty string for the mid band means "no strong steer"
// so a centered slider contributes nothing to the modifier.
const CLAUSES: Record<ToneDimension, Record<Band, string>> = {
  directness: {
    high: "Be blunt and direct — lead with the conclusion, no hedging or softening qualifiers.",
    mid: "",
    low: "Be gentle and diplomatic — soften hard edges and frame things tactfully.",
  },
  warmth: {
    high: "Be warm, encouraging, and personable.",
    mid: "",
    low: "Keep a neutral, matter-of-fact tone.",
  },
  humor: {
    high: "A touch of dry wit is welcome where it lands naturally.",
    mid: "",
    low: "Stay strictly serious — no jokes.",
  },
  brevity: {
    high: "Use the fewest words possible — terse, no preamble or filler.",
    mid: "",
    low: "Take the space to be thorough — give useful context and reasoning.",
  },
};

// Build the TONE MODIFIER block prepended to the system prompt. Derived purely
// from the sliders, so it scales with how far each dial is pushed; a fully
// centered dial yields only the framing line + the HARD RULE.
export function buildToneModifier(tone: ToneSettings): string {
  const clauses = TONE_DIMENSIONS.map((d) => CLAUSES[d.key][band(tone[d.key])]).filter(Boolean);

  const lines = [
    "TONE MODIFIER (how to phrase your answer — style only, not substance):",
    ...clauses.map((c) => `- ${c}`),
    TONE_HARD_RULE,
  ];
  return lines.join("\n");
}
