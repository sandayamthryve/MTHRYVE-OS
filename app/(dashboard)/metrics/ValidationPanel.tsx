import { Badge } from "@/components/ui";
import {
  formatMetric,
  formatVariance,
  ESCALATION_THRESHOLD_PCT,
  type ReconEntry,
} from "@/lib/metrics/reconciliation";
import { resolveMismatch } from "./reconciliation-actions";

// Validation panel (Phase 2, Part B). Lists every validation_status='mismatch'
// row for the department dashboards — metric label, manual_value, api_value,
// variance_pct — and, for leadership, the three resolution paths:
//   Keep manual · Accept API · Override (enter the correct number).
// A gap over ±15% is flagged "escalated" — the sync has already opened a pending
// action_request for it. Nothing here auto-resolves; a human decides every row.

function periodLabel(e: ReconEntry): string {
  return e.period_start === e.period_end ? e.period_start : `${e.period_start} → ${e.period_end}`;
}

export function ValidationPanel({
  mismatches,
  canOverride,
}: {
  mismatches: ReconEntry[];
  canOverride: boolean;
}) {
  if (mismatches.length === 0) {
    return (
      <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5">
        <h2 className="text-sm font-semibold text-ink">Validation</h2>
        <p className="mt-2 text-sm text-ink-muted">
          No mismatches. Every metric with both a manual figure and an API figure agrees within
          tolerance.
        </p>
      </div>
    );
  }

  // Group by department for the per-department dashboard framing.
  const byDept = new Map<string, ReconEntry[]>();
  for (const m of mismatches) {
    const key = m.department ?? "Other";
    (byDept.get(key) ?? byDept.set(key, []).get(key)!).push(m);
  }

  return (
    <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Validation</h2>
        <Badge tone="red">
          {mismatches.length} mismatch{mismatches.length === 1 ? "" : "es"}
        </Badge>
      </div>
      <p className="mb-4 text-xs text-ink-muted">
        Where the platform API disagrees with the recorded manual figure. Leadership reconciles each
        row; a gap over ±{ESCALATION_THRESHOLD_PCT}% has already opened a pending action request.
      </p>

      <div className="space-y-5">
        {Array.from(byDept.entries()).map(([dept, rows]) => (
          <div key={dept}>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              {dept}
            </h3>
            <div className="space-y-2">
              {rows.map((m) => {
                const escalated =
                  m.variance_pct != null && Math.abs(m.variance_pct) > ESCALATION_THRESHOLD_PCT;
                return (
                  <div
                    key={m.id}
                    className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-ink">{m.label}</span>
                        <span className="font-mono text-[10px] text-ink-muted">
                          {periodLabel(m)}
                        </span>
                        {escalated && <Badge tone="amber">escalated</Badge>}
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-ink-muted">
                          Manual{" "}
                          <span className="font-mono text-ink">
                            {formatMetric(m.manual_value, m.unit)}
                          </span>
                        </span>
                        <span className="text-ink-muted">
                          API{" "}
                          <span className="font-mono text-ink">
                            {formatMetric(m.api_value, m.unit)}
                          </span>
                        </span>
                        <span className="font-mono text-red-300">{formatVariance(m.variance_pct)}</span>
                      </div>
                    </div>

                    {canOverride && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-charcoal-700/60 pt-3">
                        <form action={resolveMismatch}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="choice" value="keep_manual" />
                          <button
                            type="submit"
                            className="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs text-ink hover:bg-charcoal-700"
                          >
                            Keep manual
                          </button>
                        </form>
                        <form action={resolveMismatch}>
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="choice" value="accept_api" />
                          <button
                            type="submit"
                            className="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs text-ink hover:bg-charcoal-700"
                          >
                            Accept API
                          </button>
                        </form>
                        <details className="relative">
                          <summary className="cursor-pointer list-none rounded-md bg-charcoal-800 px-2.5 py-1 text-xs text-ink hover:bg-charcoal-700">
                            Override…
                          </summary>
                          <form
                            action={resolveMismatch}
                            className="mt-2 flex items-end gap-2 rounded-md border border-charcoal-700 bg-charcoal-900 p-2"
                          >
                            <input type="hidden" name="id" value={m.id} />
                            <input type="hidden" name="choice" value="override" />
                            <label className="text-[10px] text-ink-muted">
                              Correct value
                              <input
                                name="override_value"
                                type="number"
                                step="any"
                                required
                                className="mt-1 block w-32 rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                              />
                            </label>
                            <button
                              type="submit"
                              className="rounded-md bg-teal-500 px-2.5 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400"
                            >
                              Save
                            </button>
                          </form>
                        </details>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
