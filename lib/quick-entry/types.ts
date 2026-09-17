// lib/quick-entry/types.ts — client-safe shared shapes for Mobile Quick-Entry.
//
// Kept dependency-free (no server imports) so both the server vision reader and
// the "use client" wizard import the same types with no bundling surprises.

// What a capture can be attached to (evidence_attachments.entity_type).
export const QUICK_ENTRY_ENTITIES = ["metric_entry", "daily_report", "live_session"] as const;
export type QuickEntryEntity = (typeof QUICK_ENTRY_ENTITIES)[number];

// One reading lifted off an image by the vision reader. value is null when a
// label was seen but no legible number (honest — the human still fills it in).
export interface VisionReading {
  label: string | null;
  value: number | null;
  unit: string | null;
}

// The machine reading returned by /api/quick-entry/vision. A SUGGESTION only.
export interface VisionExtract {
  value: number | null;
  label: string | null;
  unit: string | null;
  readings: VisionReading[];
  confidence: "high" | "medium" | "low" | null;
  raw: string | null;
}
