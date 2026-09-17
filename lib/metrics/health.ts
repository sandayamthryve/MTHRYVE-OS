import type { HealthDot } from "./types";

// Thresholds are NOT stored on metric_catalog/metric_entries — they live in the
// existing public.metric_targets table. This resolves a green/amber/red dot from
// a target row + a value, or null when there's no usable target (so a card with
// no target shows no dot rather than a fabricated verdict).

export interface TargetRow {
  metric: string;
  green_min: number | null;
  amber_min: number | null;
  band_low: number | null;
  band_high: number | null;
  // 'higher_better' | 'lower_better' | 'band'
  direction: string | null;
  target_value: number | null;
}

// Resolve the health dot for `value` against a metric_targets row.
//   higher_better: value >= green_min => green; >= amber_min => amber; else red.
//   lower_better:  value <= green_min => green; <= amber_min => amber; else red.
//   band:          within [band_low, band_high] => green; else red. If green/
//                  amber mins are also present they take precedence.
// Returns null when the value is null or the row has no usable thresholds.
export function healthFor(value: number | null, target: TargetRow | undefined): HealthDot {
  if (value == null || !target) return null;

  const { green_min, amber_min, band_low, band_high, direction } = target;
  const dir = direction ?? "higher_better";

  if (green_min != null || amber_min != null) {
    if (dir === "lower_better") {
      if (green_min != null && value <= green_min) return "green";
      if (amber_min != null && value <= amber_min) return "amber";
      return "red";
    }
    // higher_better (default) and any band-with-mins case
    if (green_min != null && value >= green_min) return "green";
    if (amber_min != null && value >= amber_min) return "amber";
    return "red";
  }

  if (dir === "band" && band_low != null && band_high != null) {
    return value >= band_low && value <= band_high ? "green" : "red";
  }

  // Target exists but carries no comparable thresholds — no honest verdict.
  return null;
}

export const HEALTH_COLOR: Record<Exclude<HealthDot, null>, string> = {
  green: "bg-teal-400",
  amber: "bg-amber-400",
  red: "bg-red-400",
};

export const HEALTH_LABEL: Record<Exclude<HealthDot, null>, string> = {
  green: "On target",
  amber: "At risk",
  red: "Off target",
};
