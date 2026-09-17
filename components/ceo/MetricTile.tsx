// Premium metric tile for the CEO command center. v2 "Obsidian": elevated
// gradient surface, hairline top highlight, role wash, display-font hero value,
// and an optional sparkline (the little trend line from the design peg). Props
// are backward compatible - `spark` is optional, so existing calls keep working.
export function MetricTile({
  label,
  value,
  accent = "neutral",
  delta = null,
  deltaSuffix = "",
  note,
  spark,
}: {
  label: string;
  value: string;
  accent?: "green" | "gold" | "teal" | "neutral";
  delta?: number | null;
  deltaSuffix?: string;
  note?: string;
  spark?: number[];
}) {
  const valueColor =
    accent === "green"
      ? "text-green-400"
      : accent === "gold"
      ? "text-gold-400"
      : accent === "teal"
      ? "text-teal-300"
      : "text-ink";

  const wash =
    accent === "green"
      ? "from-green-500/[.08]"
      : accent === "gold"
      ? "from-gold-500/[.08]"
      : accent === "teal"
      ? "from-teal-500/[.08]"
      : "from-transparent";

  const dotColor =
    accent === "gold"
      ? "bg-gold-400 shadow-[0_0_8px_theme(colors.gold.400)]"
      : "bg-teal-400 shadow-[0_0_8px_theme(colors.teal.400)]";

  const sparkStroke =
    accent === "green"
      ? "#6BC98A"
      : accent === "gold"
      ? "#E0BD6E"
      : "#4BC0B8";

  const W = 76;
  const H = 26;
  const pts = spark && spark.length >= 2 ? spark : null;
  let sparkPath = "";
  if (pts) {
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const range = max - min || 1;
    sparkPath = pts
      .map((v, i) => {
        const x = (i / (pts.length - 1)) * W;
        const y = H - ((v - min) / range) * H;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-4 shadow-elevate">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
      <span aria-hidden className={`pointer-events-none absolute inset-0 bg-gradient-to-b ${wash} to-transparent`} />

      {pts && (
        <svg
          aria-hidden
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute bottom-3 right-3 h-7 w-20 opacity-90"
        >
          <path d={sparkPath} fill="none" stroke={sparkStroke} strokeWidth="1.75" />
        </svg>
      )}

      <p className="relative z-10 mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-ink-muted">
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden />
        {label}
      </p>
      <p className={`relative z-10 font-display text-3xl font-bold tracking-tight ${valueColor}`}>
        {value}
      </p>
      {delta != null && delta !== 0 ? (
        <p
          className={`relative z-10 mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs ${
            delta > 0 ? "bg-green-500/10 text-green-400" : "bg-gold-500/10 text-gold-400"
          }`}
        >
          {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
          {deltaSuffix} WoW
        </p>
      ) : delta === 0 ? (
        <p className="relative z-10 mt-2 font-mono text-xs text-ink-muted">Flat vs last week</p>
      ) : note ? (
        <p className="relative z-10 mt-2 text-xs text-ink-muted">{note}</p>
      ) : null}
    </div>
  );
}
