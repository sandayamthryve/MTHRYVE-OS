// JSON2Video listing-video assembly — the SINGLE source of truth for the
// "pick a resolution → see an ESTIMATED COST → Approve & Render" gate that turns
// an item's Creative Kit into one finished MP4. JSON2Video bills real money per
// render, so nothing is ever submitted without a human seeing an estimate first,
// and the client live-preview and the server's authoritative recompute both
// import THIS module so the two can never disagree.
//
// This file is pure data + math: no key reads, no network, no server-only APIs,
// so it is safe to import from both the "use client" panel and the server action.
// The client that actually talks to JSON2Video lives in lib/json2video/client.ts,
// and the movie-template builder (which composes these categorised assets into a
// JSON2Video "movie") lives in lib/json2video/template.ts.

// The trimmed view of a content_assets row the assembly reasons over. We only
// need the kind (to categorise), a title (caption text / label), the url (the
// clip / image / audio source) and a duration (to price video scenes).
export interface AssemblySourceAsset {
  id: string;
  kind: string;
  title: string | null;
  url: string | null;
  duration_seconds: number | string | null;
}

// The content_assets kinds that become moving-footage SCENES (HeyGen + fal).
export const CLIP_KINDS = ["heygen_video", "veo_clip", "broll"] as const;
// The kinds that become still-image scenes (Canva visuals + thumbnails).
export const VISUAL_KINDS = ["canva_design", "thumbnail"] as const;

// Seconds a still visual is shown for when it has no intrinsic duration.
export const IMAGE_SCENE_SECONDS = 5;
// Fallback runtime for a clip whose duration we don't know yet.
export const DEFAULT_CLIP_SECONDS = 8;

// Coerce a numeric-ish value (PostgREST numerics arrive as strings) to a finite
// positive number of seconds, or null.
function toSeconds(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The categorised, render-ready selection built from an item's Creative Kit. The
// order of `clips`/`visuals` is the order they were passed in (the caller passes
// them oldest-first so the cut reads chronologically). captions/music/voiceover
// overlay the whole movie.
export interface AssemblySelection {
  clips: AssemblySourceAsset[];
  visuals: AssemblySourceAsset[];
  captions: AssemblySourceAsset[];
  music: AssemblySourceAsset | null;
  voiceover: AssemblySourceAsset | null;
}

// True when a selection actually has something to render (at least one scene).
export function hasRenderableScenes(sel: AssemblySelection): boolean {
  return sel.clips.length > 0 || sel.visuals.length > 0;
}

// Categorise an item's assets into the pieces the template composes. Only
// `ready`/`completed` assets with a usable source are eligible (a caption may
// carry its text in `title` instead of a url). Music/voiceover collapse to the
// single most-recent track. Never throws — an odd row is simply skipped.
export function selectAssemblyAssets(assets: AssemblySourceAsset[]): AssemblySelection {
  const clips: AssemblySourceAsset[] = [];
  const visuals: AssemblySourceAsset[] = [];
  const captions: AssemblySourceAsset[] = [];
  let music: AssemblySourceAsset | null = null;
  let voiceover: AssemblySourceAsset | null = null;

  for (const a of assets) {
    const hasUrl = Boolean(a.url && a.url.trim());
    if ((CLIP_KINDS as readonly string[]).includes(a.kind)) {
      if (hasUrl) clips.push(a);
    } else if ((VISUAL_KINDS as readonly string[]).includes(a.kind)) {
      if (hasUrl) visuals.push(a);
    } else if (a.kind === "caption") {
      // A caption is usable with either a subtitle-file url or plain title text.
      if (hasUrl || (a.title && a.title.trim())) captions.push(a);
    } else if (a.kind === "music") {
      if (hasUrl && !music) music = a;
    } else if (a.kind === "voiceover") {
      if (hasUrl && !voiceover) voiceover = a;
    }
  }

  return { clips, visuals, captions, music, voiceover };
}

// Estimated total runtime (seconds) of the assembled cut: each clip contributes
// its own duration (or DEFAULT_CLIP_SECONDS when unknown), each still visual
// contributes IMAGE_SCENE_SECONDS. Captions/music/voiceover overlay and add no
// runtime. Floored at IMAGE_SCENE_SECONDS so a lone image still reads non-zero.
export function estimateAssemblyDurationSeconds(sel: AssemblySelection): number {
  let total = 0;
  for (const c of sel.clips) total += toSeconds(c.duration_seconds) ?? DEFAULT_CLIP_SECONDS;
  total += sel.visuals.length * IMAGE_SCENE_SECONDS;
  if (total <= 0) return 0;
  return Math.max(IMAGE_SCENE_SECONDS, Math.round(total));
}

// --- Resolution tiers + cost math -------------------------------------------

// The resolutions the user can render at. `value` is the string JSON2Video's
// movie schema expects; `usdPerSecond` is the estimate rate (top of a plausible
// band so the preview never UNDER-states spend — JSON2Video bills by rendered
// output, so higher resolution costs more per second). Estimate only: the
// account's real plan/credit price is what actually applies.
export type AssemblyResolutionId = "sd" | "hd" | "full-hd";

export interface AssemblyResolution {
  id: AssemblyResolutionId;
  label: string;
  value: string;
  usdPerSecond: number;
  hint: string;
}

export const ASSEMBLY_RESOLUTIONS: AssemblyResolution[] = [
  {
    id: "sd",
    label: "SD · 640×360",
    value: "sd",
    usdPerSecond: 0.01,
    hint: "Fastest, cheapest — quick previews.",
  },
  {
    id: "hd",
    label: "HD · 1280×720",
    value: "hd",
    usdPerSecond: 0.02,
    hint: "Good balance for social.",
  },
  {
    id: "full-hd",
    label: "Full HD · 1920×1080",
    value: "full-hd",
    usdPerSecond: 0.04,
    hint: "Crisp 1080p — the default for listings.",
  },
];

// The resolution the picker starts on.
export const DEFAULT_RESOLUTION_ID: AssemblyResolutionId = "full-hd";

// The render quality we always request. High is the sensible default for a
// finished, published cut; kept constant so the only cost lever is resolution.
export const ASSEMBLY_QUALITY = "high";

// Look up a resolution by id, or null.
export function getResolution(id: string): AssemblyResolution | null {
  return ASSEMBLY_RESOLUTIONS.find((r) => r.id === id) ?? null;
}

// Coerce an untrusted form value into a known resolution (defaults to the
// default). Used server-side so a tampered form can only ever pick a real,
// priced resolution.
export function coerceResolution(v: unknown): AssemblyResolution {
  const id = typeof v === "string" ? v : "";
  return getResolution(id) ?? getResolution(DEFAULT_RESOLUTION_ID)!;
}

// Estimated USD cost = estimated seconds × the resolution's per-second rate,
// rounded to cents. The whole point of the gate — shown live as the user picks a
// resolution and recomputed authoritatively on the server before any submit.
export function estimateAssemblyCostUsd(
  sel: AssemblySelection,
  resolution: AssemblyResolution
): number {
  const seconds = estimateAssemblyDurationSeconds(sel);
  if (seconds <= 0) return 0;
  return Math.round(seconds * resolution.usdPerSecond * 100) / 100;
}

// Actual USD cost once JSON2Video reports a real duration on completion — same
// per-second rate applied to the true runtime. Falls back to null when the
// duration is unknown (honest — never invent a figure).
export function actualAssemblyCostUsd(
  durationSeconds: number | null,
  resolution: AssemblyResolution
): number | null {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  return Math.round(durationSeconds * resolution.usdPerSecond * 100) / 100;
}

// Format a USD amount for display. null/NaN → an em dash (honest — never $0.00
// for "unknown"). Kept local so this module stays self-contained for the client.
export function formatUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}
