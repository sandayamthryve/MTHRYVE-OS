// Shared vocabulary for the content_assets "Creative Kit" — the org-scoped
// table (RLS: org select/insert/update) that captures every derived asset for a
// content item: scripts, captions, Canva designs, HeyGen/Veo videos, b-roll,
// music, voiceovers, thumbnails and the final assembled cut. Kept in one place
// so the item editor's Kit panel, the org-wide Library gallery and the server
// actions that write rows all agree on the kinds, their order and their labels.
//
// We do NOT own the schema or RLS here (both were provisioned separately); this
// module only mirrors the shape the app reads and writes.

// The kinds, in the pipeline order we display groups in.
export const ASSET_KINDS = [
  "script",
  "caption",
  "canva_design",
  "heygen_video",
  "veo_clip",
  "broll",
  "music",
  "voiceover",
  "thumbnail",
  "short_clip",
  "assembled_video",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_LABEL: Record<string, string> = {
  script: "Scripts",
  caption: "Captions",
  canva_design: "Canva designs",
  heygen_video: "HeyGen videos",
  veo_clip: "Veo clips",
  broll: "B-roll",
  music: "Music",
  voiceover: "Voiceovers",
  thumbnail: "Thumbnails",
  short_clip: "Short-form clips",
  assembled_video: "Assembled videos",
};

// Singular label for one asset of a kind (used in the attach form / Library).
export const ASSET_KIND_SINGULAR: Record<string, string> = {
  script: "Script",
  caption: "Caption",
  canva_design: "Canva design",
  heygen_video: "HeyGen video",
  veo_clip: "Veo clip",
  broll: "B-roll clip",
  music: "Music track",
  voiceover: "Voiceover",
  thumbnail: "Thumbnail",
  short_clip: "Short-form clip",
  assembled_video: "Assembled video",
};

export const ASSET_KIND_ICON: Record<string, string> = {
  script: "📝",
  caption: "💬",
  canva_design: "🎨",
  heygen_video: "🎬",
  veo_clip: "🎞️",
  broll: "📹",
  music: "🎵",
  voiceover: "🎙️",
  thumbnail: "🖼️",
  short_clip: "✂️",
  assembled_video: "🎥",
};

// A row of content_assets as the app reads it. Nullable columns mirror the DB.
export type ContentAsset = {
  id: string;
  org_id: string;
  content_item_id: string | null;
  brand_id: string | null;
  kind: string;
  provider: string | null;
  title: string | null;
  url: string | null;
  thumbnail_url: string | null;
  status: string;
  cost_usd: number | string | null;
  cost_quota: number | string | null;
  duration_seconds: number | string | null;
  meta: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
};

// Columns we select for the Kit / Library reads.
export const ASSET_COLS =
  "id, org_id, content_item_id, brand_id, kind, provider, title, url, thumbnail_url, status, cost_usd, cost_quota, duration_seconds, meta, created_by, created_at";

// Soft-removed assets carry status 'removed' (content_assets has no DELETE RLS
// policy, so "remove" is an org-update to this status rather than a hard delete).
export const ASSET_REMOVED_STATUS = "removed";

// Format a cost_usd value (numeric arrives as string via PostgREST) as USD, or a
// dash when unknown — honest: null never renders as $0.00.
export function formatAssetCost(cost: number | string | null | undefined): string {
  if (cost == null || cost === "") return "—";
  const n = typeof cost === "string" ? Number(cost) : cost;
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

// Tone for a status badge — ready/completed read positive, failed negative,
// in-flight amber, everything else neutral.
export function assetStatusTone(status: string): "teal" | "amber" | "red" | "muted" {
  const s = status.toLowerCase();
  if (s === "ready" || s === "completed" || s === "done") return "teal";
  if (s === "failed" || s === "error") return "red";
  if (s === "processing" || s === "generating" || s === "pending" || s === "rendering")
    return "amber";
  return "muted";
}
