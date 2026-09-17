// lib/content/creative-guides.ts
// Creative Studio — the pillar / format / product "style guide" that turns a
// generation from a generic (and, by default, hard-selling) draft into one that
// obeys the creative brief. Three orthogonal axes:
//
//   • Content pillar  → the TONE + OBJECTIVE (what this piece is FOR). This is
//                        the PRIMARY constraint on every generation: the model
//                        must obey the pillar's style over any default sales tone.
//   • Content format  → the STRUCTURE (how the script/output is shaped). A
//                        short-form hook→retention→payoff→CTA is NOT a live-selling
//                        open→offer→urgency→close, and we never force one onto the
//                        other.
//   • Product context → the GROUNDING (what the product actually is). Angles must
//                        reflect the real product category; when specifics are
//                        missing we say so instead of inventing claims.
//
// This module is pure data + string builders (no server-only imports) so it is
// safe to import from client components (the Plan-calendar Generate panel, the
// standalone Content Studio) AND server code (the generate route, the Produce
// tab's brief action). Every generation path funnels its pillar/format/product
// through buildCreativeSystemSuffix() so the constraints read the same everywhere.

// --- Content pillars --------------------------------------------------------
export type ContentPillar = {
  key: string;
  label: string;
  objective: string;
  tone: string;
  dos: string[];
  donts: string[];
};

// The canonical pillar taxonomy. Order is the picker order. Each pillar is its
// own tone + objective + do/don't — only Promotion is openly salesy.
export const CONTENT_PILLARS: ContentPillar[] = [
  {
    key: "trend_jacking",
    label: "Trend Jacking",
    objective:
      "Ride a current trend, sound, meme or format so the piece feels native to the feed and earns reach through entertainment — not through selling.",
    tone: "Native, entertaining, culturally fluent, fast. Feels like a creator's post, not an ad.",
    dos: [
      "Lead with the trend/sound/format; make it genuinely fun or relatable",
      "Weave the product in lightly and late — a cameo, not the point",
      "Match the trend's energy and timing",
    ],
    donts: [
      "Do NOT hard-sell, list features, or push add-to-cart",
      "Do NOT open with the product or an offer",
      "Do NOT force the trend if it doesn't fit — keep it authentic",
    ],
  },
  {
    key: "educational",
    label: "Educational",
    objective: "Teach the viewer ONE useful, specific thing they can act on — earn trust by being genuinely helpful.",
    tone: "Clear, credible, generous, concrete. An expert friend, not a pitch.",
    dos: [
      "Deliver one tight, useful takeaway",
      "Show, don't just tell — a step, a demo, a before/after",
      "Let the product appear naturally as the tool that helps",
    ],
    donts: [
      "Do NOT bury the lesson under a sales pitch",
      "Do NOT overload with more than one core idea",
      "Do NOT invent facts, stats, or claims",
    ],
  },
  {
    key: "problem_solution",
    label: "Problem–Solution",
    objective: "Name a real, felt problem the audience has, then show the product resolving it.",
    tone: "Empathetic then confident. Agitate the pain honestly, land the relief.",
    dos: [
      "Open on the specific problem/pain the audience recognises",
      "Make the turn to the solution feel earned and concrete",
      "End on the changed outcome",
    ],
    donts: [
      "Do NOT invent a problem the product doesn't actually solve",
      "Do NOT exaggerate the pain into dishonesty",
      "Do NOT skip straight to selling before the problem lands",
    ],
  },
  {
    key: "social_proof",
    label: "Testimonial / Social Proof",
    objective: "Let real experience do the persuading — reviews, results, before/after, creator or customer voices.",
    tone: "Authentic, specific, credible. Someone else vouching, not the brand boasting.",
    dos: [
      "Center a real voice, review, or result",
      "Keep it specific and believable",
      "Show the proof (screens, before/after) where possible",
    ],
    donts: [
      "Do NOT fabricate reviews, numbers, or testimonials",
      "Do NOT make claims the proof doesn't support",
      "Do NOT slip into a generic brand ad tone",
    ],
  },
  {
    key: "promotion",
    label: "Promotion",
    objective: "Drive the sale directly — this is the one openly salesy pillar. Make the offer clear and the action obvious.",
    tone: "Confident, urgent, benefit-led. Openly selling is fine here.",
    dos: [
      "State the offer/value clearly and early",
      "Use urgency and a strong, single call-to-action",
      "Lead with the benefit, back it with the offer",
    ],
    donts: [
      "Do NOT invent a discount, price, or deadline that wasn't given",
      "Do NOT bury the CTA",
      "Do NOT overpromise beyond the real offer",
    ],
  },
  {
    key: "lifestyle",
    label: "Lifestyle",
    objective: "Show the product inside an aspirational or relatable everyday moment — sell the feeling and the fit, not the spec sheet.",
    tone: "Warm, aesthetic, aspirational-but-attainable. A vibe, not a pitch.",
    dos: [
      "Set a real, relatable scene the product lives in",
      "Sell the feeling / identity, let the product support it",
      "Keep it visual and mood-led",
    ],
    donts: [
      "Do NOT list features or hard-sell",
      "Do NOT make it feel staged or ad-like",
      "Do NOT ignore the product entirely — it should belong in the scene",
    ],
  },
  {
    key: "ugc",
    label: "UGC (User-Generated)",
    objective: "Feel like a genuine first-person post from a real user sharing their own experience.",
    tone: "Authentic, first-person, unpolished, conversational. Talking to a friend on camera.",
    dos: [
      "Write in first person (\"I\", \"my\") from lived experience",
      "Keep it raw, casual, and specific",
      "Let the recommendation feel personal and unforced",
    ],
    donts: [
      "Do NOT sound scripted, corporate, or like an ad read",
      "Do NOT invent an experience with false specifics",
      "Do NOT pile on hashtags or salesy CTAs",
    ],
  },
];

export const PILLAR_BY_KEY: Record<string, ContentPillar> = Object.fromEntries(
  CONTENT_PILLARS.map((p) => [p.key, p])
);

// Options for a UI <select>. `""` means "no pillar selected".
export const PILLAR_OPTIONS = CONTENT_PILLARS.map((p) => ({ value: p.key, label: p.label }));

// --- Content formats --------------------------------------------------------
export type ContentFormat = {
  key: string;
  label: string;
  structure: string;
  note: string;
};

// The format decides STRUCTURE. Live selling and short-form are shaped very
// differently; UGC and educational have their own beats. Extend as needed.
export const CONTENT_FORMATS: ContentFormat[] = [
  {
    key: "short_form",
    label: "Short-form (TikTok / Reels / Shorts)",
    structure:
      "Hook (first 3 seconds — stop the scroll) → Retention beats (2–4 quick beats that keep attention) → Payoff (the point/reveal) → CTA (one clear soft action).",
    note: "Fast, vertical, sound-on. The first 3 seconds decide everything. Do NOT use a live-selling structure.",
  },
  {
    key: "live_selling",
    label: "Live Selling",
    structure:
      "Opening (greet + hook the room) → Offer (product + value + demo talking points) → Urgency (stock/time/price pressure) → Close (repeated, explicit add-to-cart).",
    note: "A hosted, real-time selling segment with [host action] cues, objection handling, and repeated CTAs.",
  },
  {
    key: "ugc",
    label: "UGC (first-person)",
    structure:
      "First-person hook (\"Okay so I…\") → Honest context / my situation → What I tried & the moment it worked → Genuine recommendation (soft, personal).",
    note: "Talk to camera like a real user. Casual, unscripted feel. Not an ad read.",
  },
  {
    key: "educational",
    label: "Educational / How-to",
    structure:
      "Hook the problem or promise → Setup (why it matters, briefly) → Steps or the one key lesson (numbered/clear) → Recap + soft next step.",
    note: "Teach one useful thing cleanly. Value first; product appears as the tool.",
  },
];

export const FORMAT_BY_KEY: Record<string, ContentFormat> = Object.fromEntries(
  CONTENT_FORMATS.map((f) => [f.key, f])
);

export const FORMAT_OPTIONS = CONTENT_FORMATS.map((f) => ({ value: f.key, label: f.label }));

// --- Resolution (accepts a key OR a free-text label) ------------------------
const norm = (v?: string) =>
  (v ?? "").trim().toLowerCase().replace(/[\s/&_-]+/g, "");

// Resolve a pillar from a key or a human label / free-text value (so legacy
// free-text pillar strings like "UGC" or "Problem Solution" still map).
export function resolvePillar(v?: string): ContentPillar | null {
  if (!v || !v.trim()) return null;
  const n = norm(v);
  return (
    CONTENT_PILLARS.find((p) => norm(p.key) === n || norm(p.label) === n) ??
    CONTENT_PILLARS.find((p) => n.includes(norm(p.key)) || n.includes(norm(p.label))) ??
    null
  );
}

export function resolveFormat(v?: string): ContentFormat | null {
  if (!v || !v.trim()) return null;
  const n = norm(v);
  return (
    CONTENT_FORMATS.find((f) => norm(f.key) === n) ??
    CONTENT_FORMATS.find((f) => n.includes(norm(f.key))) ??
    null
  );
}

// --- Prompt blocks ----------------------------------------------------------
const has = (v?: string) =>
  !!v && v.trim().length > 0 && v.trim().toLowerCase() !== "none";

// The pillar block — the PRIMARY constraint. When a pillar is chosen its style
// overrides any default sales tone; when none is chosen we explicitly forbid
// silently defaulting to a hard sell.
export function pillarStyleBlock(pillarValue?: string): string {
  const p = resolvePillar(pillarValue);
  if (!p) {
    return [
      "CONTENT PILLAR: none selected.",
      "No content pillar was chosen — do NOT default to a hard-sell or promotional tone. Keep the piece neutral, native to the platform, and objective, and let the other context lead.",
    ].join("\n");
  }
  return [
    `CONTENT PILLAR: ${p.label} — this is the PRIMARY constraint and OVERRIDES any default sales/hard-sell tone.`,
    `Objective: ${p.objective}`,
    `Tone: ${p.tone}`,
    `DO: ${p.dos.join("; ")}.`,
    `DON'T: ${p.donts.join("; ")}.`,
    `Every hook, angle, line and script must obey this pillar. If a template or default instruction pulls toward selling and this pillar is not "Promotion", follow the pillar.`,
  ].join("\n");
}

// The format block — decides STRUCTURE. Silent when no format is given.
export function formatStructureBlock(formatValue?: string): string {
  const f = resolveFormat(formatValue);
  if (!f) return "";
  return [
    `CONTENT FORMAT: ${f.label}.`,
    `Structure to follow: ${f.structure}`,
    `${f.note}`,
    `Shape the output in THIS structure — do not force a different format's structure onto it.`,
  ].join("\n");
}

// The product block — grounds angles/copy in the REAL product. Honest about gaps.
export function productContextBlock(i: Record<string, string>): string {
  const lines: string[] = [];
  if (has(i.product_name)) lines.push(`Product: ${i.product_name}.`);
  if (has(i.product_type)) lines.push(`Product type / category: ${i.product_type}.`);
  if (has(i.product_features)) lines.push(`Key features: ${i.product_features}.`);
  if (has(i.product_benefits)) lines.push(`Benefits: ${i.product_benefits}.`);
  if (has(i.target_audience)) lines.push(`Target audience: ${i.target_audience}.`);
  const any =
    has(i.product_name) ||
    has(i.product_type) ||
    has(i.product_features) ||
    has(i.product_benefits) ||
    has(i.target_audience);
  if (!any) {
    // No structured product context — lean on brand context / title, never invent.
    if (has(i.brand_summary) || has(i.title) || has(i.brand_name)) {
      return "PRODUCT CONTEXT: no structured product details were provided — generate only from the brand situation and working title above, keep messaging to the correct product category, and do NOT invent product claims, features, or numbers.";
    }
    return "PRODUCT CONTEXT: none provided — do NOT invent product claims, features, prices, or numbers; keep the copy generic and clearly note that product specifics are missing.";
  }
  lines.push(
    "Every angle, hook and line must reflect THIS product and its real category. Do not invent claims, features, prices, or numbers beyond what is stated."
  );
  return "PRODUCT CONTEXT:\n" + lines.join("\n");
}

// The single suffix appended to a template's system prompt on every generation.
// Pillar → format → product, framed as authoritative creative constraints.
export function buildCreativeSystemSuffix(i: Record<string, string>): string {
  const blocks = [
    pillarStyleBlock(i.pillar),
    formatStructureBlock(i.format),
    productContextBlock(i),
  ].filter((b) => b && b.trim().length > 0);
  if (blocks.length === 0) return "";
  return (
    "\n\n=== CREATIVE BRIEF CONSTRAINTS (obey these; the content pillar wins over any default tone) ===\n" +
    blocks.join("\n\n") +
    "\n=== END CREATIVE BRIEF CONSTRAINTS ==="
  );
}
