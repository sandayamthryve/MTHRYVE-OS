import { int } from "@/lib/metrics/format";
import { ratePct } from "@/lib/metrics/live";

// Funnel — the impressions → clicks → orders drop-off for one session. Pure
// CSS bars (no chart dependency), widths proportional to the top of the funnel.
// A stage with no recorded count reads "—" and draws no bar; nothing is
// inferred. The CTR / CTOR conversions between stages are the guarded rates from
// the metrics layer (computed from these counts when present).

type Stage = { label: string; value: number | null };

function barWidth(value: number | null, top: number | null): string {
  if (value == null || top == null || top <= 0) return "0%";
  return `${Math.max(2, Math.min(100, (value / top) * 100))}%`;
}

export function Funnel({
  impressions,
  clicks,
  orders,
  ctr,
  ctor,
}: {
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  ctr: number | null; // 0..1 ratio
  ctor: number | null; // 0..1 ratio
}) {
  const stages: Stage[] = [
    { label: "Impressions", value: impressions },
    { label: "Clicks", value: clicks },
    { label: "Orders", value: orders },
  ];
  // The funnel scales to the largest present count so the top bar is full-width
  // even when impressions weren't recorded.
  const top = stages.reduce<number | null>(
    (m, s) => (s.value != null ? Math.max(m ?? 0, s.value) : m),
    null
  );
  const anyData = stages.some((s) => s.value != null);

  if (!anyData) {
    return <p className="text-xs text-ink-muted">No funnel counts recorded for this session.</p>;
  }

  const tones = ["bg-teal-500/70", "bg-violet-500/70", "bg-gold-500/80"];

  return (
    <div className="space-y-3">
      {stages.map((s, i) => (
        <div key={s.label}>
          <div className="mb-1 flex items-center justify-between font-mono text-[11px]">
            <span className="uppercase tracking-wider text-ink-muted">{s.label}</span>
            <span className="text-ink">{s.value != null ? int(s.value) : "—"}</span>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-charcoal-800">
            <div className={`h-full rounded-full ${tones[i]}`} style={{ width: barWidth(s.value, top) }} />
          </div>
          {/* Conversion label between this stage and the next. */}
          {i === 0 && (
            <p className="mt-1 text-right font-mono text-[10px] text-teal-300">
              CTR {ratePct(ctr)} <span className="text-ink-dim">clicks / impressions</span>
            </p>
          )}
          {i === 1 && (
            <p className="mt-1 text-right font-mono text-[10px] text-violet-300">
              CTOR {ratePct(ctor)} <span className="text-ink-dim">orders / clicks</span>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
