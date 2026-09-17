import { SectionCard, Badge } from "@/components/ui";
import type { DashboardMetric } from "@/lib/metrics/types";
import { formatValue } from "@/lib/metrics/display";
import { HEALTH_COLOR, HEALTH_LABEL } from "@/lib/metrics/health";

// The account_health-category metrics as a compliance panel with a green/amber/
// red rollup. The overall verdict is the WORST band present among metrics that
// have a target (metrics without a target don't fabricate a verdict). If no
// account_health metric has a target yet, the rollup reads "No targets set".
export function AccountHealthPanel({ metrics }: { metrics: DashboardMetric[] }) {
  if (metrics.length === 0) return null;

  const withHealth = metrics.filter((m) => m.health != null);
  const counts = {
    green: withHealth.filter((m) => m.health === "green").length,
    amber: withHealth.filter((m) => m.health === "amber").length,
    red: withHealth.filter((m) => m.health === "red").length,
  };
  const overall =
    counts.red > 0 ? "red" : counts.amber > 0 ? "amber" : counts.green > 0 ? "green" : null;

  return (
    <SectionCard
      title="Account Health"
      className="mb-6"
      action={
        overall ? (
          <span className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${HEALTH_COLOR[overall]}`} />
            <span className="text-xs font-semibold text-ink">{HEALTH_LABEL[overall]}</span>
            <span className="font-mono text-[10px] text-ink-dim">
              {counts.green}✓ / {counts.amber}⚠ / {counts.red}✕
            </span>
          </span>
        ) : (
          <Badge tone="muted">No targets set</Badge>
        )
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((m) => (
          <div
            key={m.metric_key}
            className="flex items-center justify-between rounded-lg border border-charcoal-700/60 bg-charcoal-950 px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                  m.health ? HEALTH_COLOR[m.health] : "bg-charcoal-600"
                }`}
                title={m.health ? HEALTH_LABEL[m.health] : "No target"}
              />
              <span className="truncate text-xs text-ink-muted">{m.label}</span>
            </span>
            <span
              className={`font-mono text-xs ${m.display_value != null ? "text-ink" : "text-ink-dim"}`}
            >
              {formatValue(m.display_value, m.unit)}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
