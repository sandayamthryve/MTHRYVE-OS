// lib/metrics/reconciliation.ts — shared types + display rules for the API
// Validation Overlay (Phase 2). Kept separate from lib/metrics/format.ts (which
// owns GMV formatting) so the reconciliation surfaces share one contract for
// "which number is the headline" and "how do I render a metric by its unit".

import { peso, int, EMPTY } from "@/lib/metrics/format";

export type MetricUnit = "currency" | "count" | "rate" | "number";

export type ValidationStatus =
  | "pending"
  | "manual_only"
  | "api_only"
  | "match"
  | "mismatch"
  | "overridden";

// The row shape both the page and the panel read (catalog joined onto entry).
export interface ReconEntry {
  id: string;
  metric_key: string;
  label: string;
  department: string | null;
  unit: MetricUnit;
  is_money: boolean;
  period_start: string;
  period_end: string;
  manual_value: number | null;
  api_value: number | null;
  variance_pct: number | null;
  validation_status: ValidationStatus;
  origin: "manual" | "api" | "reconciled";
  override_choice: "keep_manual" | "accept_api" | "override" | null;
}

// Part C headline rule: show api_value when the row is TRUSTED (a match, or a
// human 'overridden' decision); otherwise show the manual floor. Never blend.
export function headlineValue(e: {
  validation_status: ValidationStatus;
  manual_value: number | null;
  api_value: number | null;
}): number | null {
  if (e.validation_status === "match" || e.validation_status === "overridden") {
    return e.api_value;
  }
  return e.manual_value;
}

export function formatMetric(value: number | null | undefined, unit: MetricUnit): string {
  if (value == null) return EMPTY;
  const n = Number(value);
  if (!Number.isFinite(n)) return EMPTY;
  switch (unit) {
    case "currency":
      return peso(n);
    case "rate":
      // Stored as a ratio (0..1) → shown as a percentage.
      return `${(n * 100).toFixed(2)}%`;
    case "count":
      return int(n);
    default:
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
  }
}

export function formatVariance(variancePct: number | null | undefined): string {
  if (variancePct == null) return EMPTY;
  const n = Number(variancePct);
  if (!Number.isFinite(n)) return EMPTY;
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

// The variance that trips a human-review escalation (kept in sync with
// lib/metrics/sync.ts ESCALATION_THRESHOLD_PCT).
export const ESCALATION_THRESHOLD_PCT = 15;
