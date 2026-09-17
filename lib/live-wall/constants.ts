// lib/live-wall/constants.ts — shared vocabulary for the Live & Video Wall.
//
// Dependency-free so both server (page, actions, metrics) and client (filters,
// players) can import it without pulling in server-only modules.

// The Live compartment code (metric_compartments.code) whose entries feed the
// tiles and Tony's live-coach loop. "T4 · LIVE & Video".
export const LIVE_COMPARTMENT_CODE = "T4";

// The platforms the wall knows how to label and filter by (task's set), plus the
// TikTok Shop variant the live spine already stores. Free-text platform values
// outside this map still render — they just fall back to their raw string.
export const WALL_PLATFORMS = [
  { value: "tiktok", label: "TikTok" },
  { value: "tiktok_shop", label: "TikTok Shop" },
  { value: "shopee", label: "Shopee" },
  { value: "lazada", label: "Lazada" },
  { value: "youtube", label: "YouTube" },
] as const;

export const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(
  WALL_PLATFORMS.map((p) => [p.value, p.label])
);

export function platformLabel(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "—";
  return PLATFORM_LABEL[v] ?? v;
}

// Operational session status (live_sessions.status) → display + tone.
export const SESSION_STATUSES = ["scheduled", "live", "ended"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  live: "🔴 Live now",
  ended: "Ended",
};

export function statusLabel(status: string | null | undefined): string {
  const s = (status ?? "").trim();
  return STATUS_LABEL[s] ?? (s || "—");
}
