// lib/contracts/display.ts — presentation helpers for the Reports-vs-Contract
// module. Labels, tones and value formatting live here so the transparency
// view, the per-department "My delivery" view, the org scorecard and the
// contract detail page never drift on how a deliverable type, a status or an
// attainment figure reads.

import type { BadgeTone } from "@/components/ui";
import type { AttainmentFlag, DeliverableType, Attainment } from "@/lib/metrics/contracts";
import { DELIVERABLE_TYPES } from "@/lib/metrics/contracts";
import { peso, int, EMPTY } from "@/lib/metrics/format";

// Re-exported so pages can iterate the deliverable types for <select> options
// without importing from two modules.
export const DELIVERABLE_TYPES_LIST: DeliverableType[] = DELIVERABLE_TYPES;

export const DELIVERABLE_LABEL: Record<DeliverableType, string> = {
  gmv: "GMV",
  content: "Content",
  live: "Live",
  ads: "Ads",
  other: "Other",
};

export const DELIVERABLE_TONE: Record<DeliverableType, BadgeTone> = {
  gmv: "amber",
  content: "violet",
  live: "red",
  ads: "teal",
  other: "muted",
};

// Scope item lifecycle. 'planned' → not yet turned into a project; 'deployed' →
// a project exists (set by the one-click deploy); the rest are free-form manual
// states a writer may set.
export const SCOPE_STATUSES = ["planned", "deployed", "active", "done", "cancelled"] as const;
export const SCOPE_STATUS_LABEL: Record<string, string> = {
  planned: "Planned",
  deployed: "Deployed",
  active: "Active",
  done: "Done",
  cancelled: "Cancelled",
};

export const CONTRACT_STATUSES = ["active", "paused", "ended", "draft"] as const;
export const CONTRACT_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  ended: "Ended",
  draft: "Draft",
};
export function contractStatusTone(status: string): BadgeTone {
  switch (status) {
    case "active":
      return "teal";
    case "paused":
      return "amber";
    case "ended":
      return "muted";
    default:
      return "violet";
  }
}

// The attainment verdict as a badge tone + short label.
export function flagTone(flag: AttainmentFlag): BadgeTone {
  switch (flag) {
    case "on_track":
      return "teal";
    case "behind":
      return "red";
    case "no_target":
      return "amber";
    case "manual":
      return "violet";
    default:
      return "muted";
  }
}
export function flagLabel(flag: AttainmentFlag): string {
  switch (flag) {
    case "on_track":
      return "On track";
    case "behind":
      return "Behind";
    case "no_target":
      return "No target";
    case "no_data":
      return "No data";
    case "manual":
      return "Manual";
    default:
      return flag;
  }
}

// Format a target/actual value honouring whether it's money, a count or hours.
export function formatValue(v: number | null | undefined, a: Attainment): string {
  if (v == null) return EMPTY;
  if (a.isMoney) return peso(Number(v));
  // Hours keep one decimal; counts are whole numbers.
  const unit = (a.unit ?? "").toLowerCase();
  if (unit.includes("hour") || unit.includes("hr")) {
    return `${Math.round(Number(v) * 10) / 10}h`;
  }
  return int(Number(v));
}

// "72%" attainment, or the em-dash when it can't be graded.
export function formatAttainmentPct(a: Attainment): string {
  if (a.attainmentPct == null) return EMPTY;
  return `${Math.round(a.attainmentPct)}%`;
}

// A YYYY-MM-DD → "Jul 12, 2026", matching lib/projects/display.formatDate.
export function formatDate(value: string | null): string {
  if (!value) return EMPTY;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}
