import { Badge } from "@/components/ui";
import type { DashboardMetric } from "@/lib/metrics/types";
import {
  formatValue,
  formatDelta,
  ORIGIN_LABEL,
  ORIGIN_TONE,
  VALIDATION_LABEL,
  VALIDATION_TONE,
} from "@/lib/metrics/display";
import { HEALTH_COLOR, HEALTH_LABEL } from "@/lib/metrics/health";

// One metric tile: the value (or "—"), an origin chip, a validation badge when
// relevant, and a health dot from metric_targets (absent when there's no
// target). CALCULATED metrics are read-only and show their formula on hover.
// Purely presentational — safe to render on the server.
export function MetricCard({
  metric,
  showCompare,
}: {
  metric: DashboardMetric;
  showCompare: boolean;
}) {
  const isCalculated = !!metric.formula;
  const hasValue = metric.display_value != null;
  const showValidation =
    metric.validation_status !== "unvalidated" &&
    metric.manual_value != null &&
    metric.api_value != null
      ? true
      : metric.validation_status === "overridden";

  const delta = metric.delta_pct;
  const deltaTone =
    delta == null
      ? "text-ink-dim"
      : (metric.direction === "down" ? delta < 0 : delta > 0)
        ? "text-teal-300"
        : delta === 0
          ? "text-ink-dim"
          : "text-red-300";

  return (
    <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {metric.health && (
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${HEALTH_COLOR[metric.health]}`}
              title={HEALTH_LABEL[metric.health]}
              aria-label={HEALTH_LABEL[metric.health]}
            />
          )}
          <span
            className="truncate text-xs font-medium text-ink-muted"
            title={isCalculated ? `Calculated: ${metric.formula}` : metric.label}
          >
            {metric.label}
          </span>
        </div>
        {metric.display_origin && (
          <Badge tone={ORIGIN_TONE[metric.display_origin]}>
            {ORIGIN_LABEL[metric.display_origin]}
          </Badge>
        )}
      </div>

      <div className="flex items-end justify-between gap-2">
        <p className={`font-mono text-lg ${hasValue ? "text-ink" : "text-ink-dim"}`}>
          {formatValue(metric.display_value, metric.unit)}
        </p>
        {showCompare && metric.compare_value != null && (
          <span className={`font-mono text-[11px] ${deltaTone}`} title="vs. comparison period">
            {formatDelta(delta)}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {isCalculated && <Badge tone="muted">Read-only</Badge>}
        {showValidation && (
          <Badge tone={VALIDATION_TONE[metric.validation_status]}>
            {VALIDATION_LABEL[metric.validation_status]}
          </Badge>
        )}
        {metric.variance_pct != null && (
          <span className="font-mono text-[10px] text-ink-dim" title="Manual vs API variance">
            Δ {metric.variance_pct}%
          </span>
        )}
        {metric.approved_at && (
          <span className="font-mono text-[10px] text-teal-400/70" title="Approved by leadership">
            ✓ approved
          </span>
        )}
      </div>
    </div>
  );
}
