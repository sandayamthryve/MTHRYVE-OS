// fal.ai generative-video model catalog + cost math — the SINGLE source of truth
// behind the "pick a model → see an ESTIMATED COST → Approve & Generate" gate.
// fal bills real money per clip, so nothing is ever submitted without a human
// seeing an estimate first, and the client live-preview and the server's
// authoritative recompute both import THIS module so they can never disagree.
//
// This file is pure data + math: no key reads, no network, no server-only APIs,
// so it is safe to import from both the "use client" panel and the server action.
// The client that actually talks to fal lives in lib/fal/client.ts.
//
// The fal model *slugs* below are the queue endpoints we POST to. fal renames /
// versions these over time — keep them here (one place) so a slug change is a
// one-line edit, never a hunt across the app. Verify against fal.ai/models when
// a model 404s.

// A model the user can pick. `tier` drives BOTH the price band and the
// content_assets `kind` we write: hero → 'veo_clip', draft → 'broll'.
export type FalTier = "draft" | "hero";

export interface FalVideoModel {
  // Stable internal id used in forms/URLs — NOT the fal slug (kept independent so
  // a slug change never breaks a saved reference or an in-flight row's meta).
  id: string;
  // Human label shown in the picker.
  label: string;
  // Short one-line positioning shown under the label.
  hint: string;
  tier: FalTier;
  // The fal queue slug for the text→video endpoint.
  slug: string;
  // The fal queue slug for the image→video endpoint, when the model has one.
  // null → the model only accepts a text prompt.
  imageSlug: string | null;
  // USD per output second — the estimate rate. Set to the top of fal's quoted
  // band so the preview never UNDER-states spend. Veo 3.1 Standard ≈ $0.75/s
  // ⇒ ~$6 for an 8s hero clip.
  usdPerSecond: number;
  // Selectable clip lengths (seconds) and the default. fal models each accept a
  // fixed set; these mirror the common options.
  durationOptions: number[];
  defaultDurationSeconds: number;
  // How this model wants `duration` in its input body: a bare number-string
  // ("5") or a suffixed one ("5s"). Centralised because fal is inconsistent.
  durationFormat: "plain" | "suffix";
  // When true the UI flags this model as an expensive hero-shot choice (Veo).
  flagExpensive: boolean;
}

// The catalog, in display order. Kling 3.0 and Luma Ray 2 are the cheap DRAFT
// models (Ray 2 is the default); Veo 3.1 Standard is the expensive HERO model.
export const FAL_VIDEO_MODELS: FalVideoModel[] = [
  {
    id: "luma_ray2",
    label: "Luma Ray 2",
    hint: "Fast, cinematic drafts — the default for b-roll.",
    tier: "draft",
    slug: "fal-ai/luma-dream-machine/ray-2",
    imageSlug: "fal-ai/luma-dream-machine/ray-2/image-to-video",
    usdPerSecond: 0.1,
    durationOptions: [5, 9],
    defaultDurationSeconds: 5,
    durationFormat: "suffix",
    flagExpensive: false,
  },
  {
    id: "kling_v3",
    label: "Kling 3.0",
    hint: "Strong motion & prompt-adherence drafts.",
    tier: "draft",
    slug: "fal-ai/kling-video/v2/master/text-to-video",
    imageSlug: "fal-ai/kling-video/v2/master/image-to-video",
    usdPerSecond: 0.14,
    durationOptions: [5, 10],
    defaultDurationSeconds: 5,
    durationFormat: "plain",
    flagExpensive: false,
  },
  {
    id: "veo_31_standard",
    label: "Veo 3.1 Standard",
    hint: "Highest fidelity — reserve for hero shots.",
    tier: "hero",
    slug: "fal-ai/veo3.1",
    imageSlug: "fal-ai/veo3.1/image-to-video",
    usdPerSecond: 0.75,
    durationOptions: [8],
    defaultDurationSeconds: 8,
    durationFormat: "suffix",
    flagExpensive: true,
  },
];

// The default draft model the picker starts on.
export const DEFAULT_FAL_MODEL_ID = "luma_ray2";

// Look up a model by id, or null.
export function getFalModel(id: string): FalVideoModel | null {
  return FAL_VIDEO_MODELS.find((m) => m.id === id) ?? null;
}

// Coerce an untrusted form value into a known model id (defaults to the draft
// default). Used server-side so a tampered form can only ever pick a real,
// priced model — never an arbitrary slug.
export function coerceFalModel(v: unknown): FalVideoModel {
  const id = typeof v === "string" ? v : "";
  return getFalModel(id) ?? getFalModel(DEFAULT_FAL_MODEL_ID)!;
}

// Clamp a requested duration to one the model actually offers (defaults to the
// model's default). Server-side guard against tampered/absent values.
export function coerceDuration(model: FalVideoModel, v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return model.durationOptions.includes(n) ? n : model.defaultDurationSeconds;
}

// The content_assets `kind` for a model: hero shots are 'veo_clip', drafts are
// 'broll'. Both already exist in lib/content/assets ASSET_KINDS.
export function assetKindForModel(model: FalVideoModel): "veo_clip" | "broll" {
  return model.tier === "hero" ? "veo_clip" : "broll";
}

// Estimated USD cost = seconds × the model's per-second rate, rounded to cents.
// The whole point of the gate — shown live as the user picks model/duration and
// recomputed authoritatively on the server before any submit.
export function estimateFalCostUsd(model: FalVideoModel, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.round(durationSeconds * model.usdPerSecond * 100) / 100;
}

// Format the `duration` value the way a given model's input body expects it.
export function durationParam(model: FalVideoModel, durationSeconds: number): string {
  return model.durationFormat === "suffix" ? `${durationSeconds}s` : String(durationSeconds);
}

// Format a USD amount for display. null/NaN → an em dash (honest — never $0.00
// for "unknown"). Kept local so this module stays self-contained for the client.
export function formatUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}

// Count of models we expose — surfaced by the /diag route as a cheap "the
// catalog loaded" signal (sampleModelsCount) without leaking anything sensitive.
export function sampleModelsCount(): number {
  return FAL_VIDEO_MODELS.length;
}
