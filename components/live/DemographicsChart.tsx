import type { DemoRollup, DemoSlice } from "@/lib/metrics/live";

// DemographicsChart — audience mix (age / gender / location) as horizontal
// share bars. Consumes the rolled-up slices from the metrics layer, which are
// already shares of each facet total. Empty facets render an honest "no data"
// line rather than an empty axis. Pure CSS, no chart dependency.

const FACET_TONE: Record<string, string> = {
  age: "bg-teal-500/70",
  gender: "bg-violet-500/70",
  location: "bg-gold-500/80",
};

function FacetBars({ title, facet, slices }: { title: string; facet: string; slices: DemoSlice[] }) {
  return (
    <div>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">{title}</p>
      {slices.length === 0 ? (
        <p className="text-xs text-ink-muted">No {title.toLowerCase()} data recorded.</p>
      ) : (
        <ul className="space-y-2">
          {slices.map((s) => (
            <li key={s.key}>
              <div className="mb-0.5 flex items-center justify-between text-[11px]">
                <span className="truncate text-ink">{s.key}</span>
                <span className="font-mono text-ink-muted">{Math.round(s.pct)}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-charcoal-800">
                <div
                  className={`h-full rounded-full ${FACET_TONE[facet] ?? "bg-teal-500/70"}`}
                  style={{ width: `${Math.max(2, Math.min(100, s.pct))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DemographicsChart({ rollup }: { rollup: DemoRollup }) {
  if (!rollup.hasData) {
    return (
      <p className="text-xs text-ink-muted">
        No demographics recorded yet — add age / gender / location breakdowns when logging a session.
      </p>
    );
  }
  return (
    <div className="grid gap-6 sm:grid-cols-3">
      <FacetBars title="Age" facet="age" slices={rollup.age} />
      <FacetBars title="Gender" facet="gender" slices={rollup.gender} />
      <FacetBars title="Location" facet="location" slices={rollup.location} />
    </div>
  );
}
