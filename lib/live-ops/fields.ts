// lib/live-ops/fields.ts — the Daily Live Report standard-metrics catalog.
//
// The Daily Live Report is HYBRID: a field auto-fills from the platform API
// where the API can deliver it, otherwise the anchor encodes it by hand. TikTok
// exposes almost nothing at live-session granularity today, so the encode form
// is the PRIMARY path and nearly every field is `manual`. Each field declares
// its lane so the form can show the origin next to it and a save can flag when a
// manual entry diverges from a previously-synced `api` value.
//
// `lane` semantics (mirrors the metric_catalog lanes from migration 0025):
//   • 'auto'          — the API delivers this at session granularity today.
//   • 'auto_possible' — the API could deliver it once the scope is live; manual
//                       for now.
//   • 'manual'        — only ever hand-encoded (the anchor reads it off-screen).

export type FieldLane = "auto" | "auto_possible" | "manual";
export type FieldKind = "currency" | "int" | "percent" | "text";

export interface ReportField {
  key: string; // live_sessions column name
  label: string;
  group: "sales" | "audience" | "engagement";
  kind: FieldKind;
  lane: FieldLane;
  hint?: string;
}

// Ordered by report section. Lanes reflect what the TikTok Shop LIVE API can
// deliver TODAY — which is essentially nothing per-session — so everything is
// manual/auto_possible. When a real sync lands it flips a field to 'api' at the
// row level (source='api'); this catalog only decides how the form labels it.
export const REPORT_FIELDS: ReportField[] = [
  // ── Sales ──
  { key: "gmv", label: "GMV", group: "sales", kind: "currency", lane: "auto_possible" },
  { key: "total_sales", label: "Total sales", group: "sales", kind: "currency", lane: "manual" },
  { key: "orders", label: "Orders", group: "sales", kind: "int", lane: "auto_possible" },
  { key: "units_sold", label: "Units sold", group: "sales", kind: "int", lane: "auto_possible" },
  { key: "aov", label: "Average order value", group: "sales", kind: "currency", lane: "manual", hint: "GMV / orders when both are entered" },
  { key: "conversion_rate", label: "Conversion rate", group: "sales", kind: "percent", lane: "manual" },
  // ── Audience ──
  { key: "impressions", label: "Impressions", group: "audience", kind: "int", lane: "manual" },
  { key: "viewers", label: "Viewers", group: "audience", kind: "int", lane: "manual" },
  { key: "peak_viewers", label: "Peak viewers", group: "audience", kind: "int", lane: "manual" },
  { key: "avg_viewers", label: "Avg viewers", group: "audience", kind: "int", lane: "manual" },
  { key: "viewer_retention", label: "Viewer retention", group: "audience", kind: "percent", lane: "manual" },
  { key: "returning_viewers", label: "Returning viewers", group: "audience", kind: "int", lane: "manual" },
  { key: "new_followers", label: "New followers", group: "audience", kind: "int", lane: "manual" },
  // ── Engagement ──
  { key: "product_clicks", label: "Product clicks", group: "engagement", kind: "int", lane: "manual" },
  { key: "clicks", label: "Clicks", group: "engagement", kind: "int", lane: "manual" },
  { key: "ctr", label: "CTR", group: "engagement", kind: "percent", lane: "manual", hint: "clicks / impressions when both entered" },
  { key: "likes", label: "Likes", group: "engagement", kind: "int", lane: "manual" },
  { key: "shares", label: "Shares", group: "engagement", kind: "int", lane: "manual" },
  { key: "comments", label: "Comments", group: "engagement", kind: "int", lane: "manual" },
  { key: "engagement_rate", label: "Engagement rate", group: "engagement", kind: "percent", lane: "manual" },
];

export const LANE_LABEL: Record<FieldLane, string> = {
  auto: "API",
  auto_possible: "API-ready",
  manual: "Manual",
};

// Badge tone per lane for the origin chip.
export const LANE_TONE: Record<FieldLane, "teal" | "amber" | "violet" | "muted"> = {
  auto: "teal",
  auto_possible: "violet",
  manual: "muted",
};

// The origin a SAVED row shows for a field: if the row's source is 'api', the
// value came from the platform; otherwise it was hand-encoded. This is the
// row-level truth the UI shows so a manual save never masquerades as API data.
export function originOf(source: string): "api" | "manual" {
  return source === "api" || source === "tiktok_api" ? "api" : "manual";
}

export const REPORT_FIELDS_BY_GROUP = {
  sales: REPORT_FIELDS.filter((f) => f.group === "sales"),
  audience: REPORT_FIELDS.filter((f) => f.group === "audience"),
  engagement: REPORT_FIELDS.filter((f) => f.group === "engagement"),
} as const;
