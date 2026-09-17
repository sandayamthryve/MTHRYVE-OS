import {
  formatMetric,
  formatVariance,
  headlineValue,
  type MetricUnit,
  type ValidationStatus,
} from "@/lib/metrics/reconciliation";

// MetricValue (Phase 2, Part C — origin visibility).
//
// Renders the HEADLINE value by the Part-C rule (api_value when the row is a
// match / overridden, else the manual floor — never blended), and, when the row
// is reconciled (both a manual floor and an API value exist), reveals BOTH
// numbers + the variance on hover. Pure CSS hover (group/group-hover) — no
// client JS, so it drops into server components.

export interface MetricValueProps {
  unit: MetricUnit;
  manualValue: number | null;
  apiValue: number | null;
  variancePct: number | null;
  status: ValidationStatus;
}

export function MetricValue({ unit, manualValue, apiValue, variancePct, status }: MetricValueProps) {
  const headline = headlineValue({
    validation_status: status,
    manual_value: manualValue,
    api_value: apiValue,
  });
  // "Reconciled" for display = both numbers are present, so the hover can show
  // manual vs API. (Covers reconciled / match / mismatch / overridden rows.)
  const reconciled = manualValue != null && apiValue != null;

  const dotTone =
    status === "match"
      ? "bg-teal-400"
      : status === "overridden"
        ? "bg-violet-400"
        : status === "mismatch"
          ? "bg-red-400"
          : "bg-charcoal-500";

  return (
    <span className="group relative inline-flex items-center gap-1.5">
      {reconciled && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${dotTone}`}
          aria-hidden="true"
        />
      )}
      <span className="font-mono text-ink">{formatMetric(headline, unit)}</span>

      {reconciled && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-20 mb-1 hidden w-max min-w-[11rem] rounded-lg border border-charcoal-700 bg-charcoal-950 p-3 text-left shadow-elevate group-hover:block"
        >
          <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
            Reconciled
          </span>
          <span className="flex items-center justify-between gap-6 text-xs">
            <span className="text-ink-muted">Manual</span>
            <span className="font-mono text-ink">{formatMetric(manualValue, unit)}</span>
          </span>
          <span className="flex items-center justify-between gap-6 text-xs">
            <span className="text-ink-muted">API</span>
            <span className="font-mono text-ink">{formatMetric(apiValue, unit)}</span>
          </span>
          <span className="mt-1 flex items-center justify-between gap-6 border-t border-charcoal-700/60 pt-1 text-xs">
            <span className="text-ink-muted">Variance</span>
            <span className="font-mono text-ink">{formatVariance(variancePct)}</span>
          </span>
        </span>
      )}
    </span>
  );
}
