// A small, dependency-free horizontal bar chart for the Contractor Status
// Overview. Pure presentational server component — bars are scaled to the
// largest value so a glance shows the mix. Colours come from the app's accent
// tokens (distinct hues per category, readable on the charcoal surface).

export type ChartSegment = { label: string; value: number; color: string };

export function StatusChart({ segments }: { segments: ChartSegment[] }) {
  const max = Math.max(1, ...segments.map((s) => s.value));
  const total = segments.reduce((a, s) => a + s.value, 0);

  if (total === 0) {
    return (
      <p className="py-6 text-center text-sm text-ink-muted">
        No status activity to chart yet today.
      </p>
    );
  }

  return (
    <ul className="space-y-2.5" aria-label="Contractor status distribution">
      {segments.map((s) => (
        <li key={s.label} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-ink-muted">{s.label}</span>
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-charcoal-800">
            <div
              className={`h-full rounded-full ${s.color}`}
              style={{ width: `${(s.value / max) * 100}%` }}
              role="img"
              aria-label={`${s.label}: ${s.value}`}
            />
          </div>
          <span className="w-8 shrink-0 text-right font-mono text-xs text-ink">{s.value}</span>
        </li>
      ))}
    </ul>
  );
}
