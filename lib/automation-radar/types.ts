// lib/automation-radar/types.ts — the Automation Radar model.
//
// public.repetition_patterns is ONE org-wide detector's output: repeated units of
// work mined from real tasks, each classified by how automatable it is and linked
// to a real capability / workflow when one exists. It is provisioned by migration
// 0026 but not in the generated Database types, so readers/writers reach it
// through the app's cast shim on the caller's RLS client.
//
// This module is CLIENT-SAFE: types + pure display/classification helpers only. No
// Supabase, no server imports — so the reusable <AutomationRadar> component (server)
// and its row-action island (client) share one source of truth for chips + labels.

// How automatable a detected pattern is. Ordered by how much a machine can take
// over: automatable (a live capability/workflow exists) → templatable (regular,
// low-judgment → a recurring template) → sop (repeatable but manual → write an
// SOP) → keep_human (needs judgment each run → never auto-run).
export const AUTOMATABILITY = ["automatable", "templatable", "sop", "keep_human"] as const;
export type Automatability = (typeof AUTOMATABILITY)[number];

export function isAutomatability(v: unknown): v is Automatability {
  return typeof v === "string" && (AUTOMATABILITY as readonly string[]).includes(v);
}

// The lifecycle of a pattern. detected (fresh from the engine) → proposed (a human
// filed it to the approval queue) or dismissed (not worth automating); approved /
// automated are leadership-only outcomes (DB-guarded).
export const PATTERN_STATUS = [
  "detected",
  "proposed",
  "approved",
  "dismissed",
  "automated",
] as const;
export type PatternStatus = (typeof PATTERN_STATUS)[number];

export function isPatternStatus(v: unknown): v is PatternStatus {
  return typeof v === "string" && (PATTERN_STATUS as readonly string[]).includes(v);
}

// The public shape of a pattern the UI renders. Mirrors the columns the surface
// needs — never the org_id / created_at bookkeeping.
export interface RepetitionPattern {
  id: string;
  pattern_key: string;
  normalized_title: string;
  sample_titles: string[];
  department: string | null;
  assignee_id: string | null;
  occurrences: number;
  first_seen: string | null;
  last_seen: string | null;
  cadence: string | null;
  avg_interval_days: number | null;
  est_minutes_each: number | null;
  time_cost_per_month: number | null;
  automatability: Automatability | null;
  suggested_path: string | null;
  matched_capability_id: string | null;
  matched_workflow: string | null;
  status: PatternStatus;
}

// ── Classification display (mirrors the Vesper Core status chips) ──────────────
export interface AutomatabilityMeta {
  label: string;
  /** Full chip classes (border + bg + text) for a pill. */
  chip: string;
  /** A short one-liner for tooltips / empty states. */
  blurb: string;
}

export const AUTOMATABILITY_META: Record<Automatability, AutomatabilityMeta> = {
  automatable: {
    label: "Automatable",
    chip: "border-green-500/40 bg-green-500/15 text-green-400",
    blurb: "A live capability or workflow already exists — link it and propose.",
  },
  templatable: {
    label: "Templatable",
    chip: "border-teal-500/40 bg-teal-500/15 text-teal-300",
    blurb: "Regular cadence, low judgment — a recurring task template fits.",
  },
  sop: {
    label: "SOP",
    chip: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    blurb: "Repeatable but manual — write an SOP so anyone can run it.",
  },
  keep_human: {
    label: "Keep human",
    chip: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
    blurb: "Needs judgment each run — do not automate.",
  },
};

// ── Status display ─────────────────────────────────────────────────────────────
export const PATTERN_STATUS_META: Record<PatternStatus, { label: string; chip: string }> = {
  detected: { label: "Detected", chip: "border-charcoal-700 bg-charcoal-800 text-ink-muted" },
  proposed: { label: "Proposed", chip: "border-amber-500/40 bg-amber-500/15 text-amber-300" },
  approved: { label: "Approved", chip: "border-violet-500/40 bg-violet-500/15 text-violet-300" },
  dismissed: { label: "Dismissed", chip: "border-charcoal-700 bg-charcoal-900 text-ink-dim" },
  automated: { label: "Automated", chip: "border-green-500/40 bg-green-500/15 text-green-400" },
};

// Minutes → a compact "3h 20m" / "45m" label for the time-saved column.
export function formatMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return "—";
  const rounded = Math.round(min);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// A human label for the est. monthly time cost (what automating would save).
export function monthlyTimeSaved(pattern: Pick<RepetitionPattern, "time_cost_per_month">): string {
  return formatMinutes(pattern.time_cost_per_month);
}
