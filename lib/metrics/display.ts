import type { Origin, Unit, ValidationStatus } from "./types";
import type { BadgeTone } from "@/components/ui";

// Presentation helpers for the Hybrid Metrics Floor dashboards. Kept separate
// from the older lib/metrics/format.ts (GMV-surface formatters) so neither
// module's exports collide. A null value is the honest empty state — always
// "—", never 0.
export function formatValue(value: number | null, unit: Unit): string {
  if (value == null) return "—";
  switch (unit) {
    case "currency":
      try {
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "PHP",
          maximumFractionDigits: 0,
        }).format(value);
      } catch {
        return `PHP ${Math.round(value).toLocaleString()}`;
      }
    case "percent":
      return `${trim(value)}%`;
    case "hours":
      return `${trim(value)}h`;
    case "rating":
      return `${trim(value)}★`;
    case "count":
    default:
      return trim(value).toLocaleString();
  }
}

// Drop insignificant trailing zeros: 12.00 -> 12, 12.50 -> 12.5.
function trim(n: number): number {
  return Math.round(n * 100) / 100;
}

// A signed delta % string for the compare toggle (e.g. "+12.3%", "−4%").
export function formatDelta(delta: number | null): string {
  if (delta == null) return "—";
  const rounded = Math.round(delta * 10) / 10;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded)}%`;
}

export const ORIGIN_LABEL: Record<Origin, string> = {
  manual: "Manual",
  api: "API",
  reconciled: "Reconciled",
  calculated: "Calculated",
};

export const ORIGIN_TONE: Record<Origin, BadgeTone> = {
  manual: "violet",
  api: "teal",
  reconciled: "teal",
  calculated: "muted",
};

export const VALIDATION_LABEL: Record<ValidationStatus, string> = {
  unvalidated: "Unvalidated",
  match: "Match",
  mismatch: "Mismatch",
  overridden: "Overridden",
};

export const VALIDATION_TONE: Record<ValidationStatus, BadgeTone> = {
  unvalidated: "muted",
  match: "teal",
  mismatch: "red",
  overridden: "amber",
};
