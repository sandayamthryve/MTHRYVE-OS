import type { ReactNode } from "react";

// A Card variant for a single KPI: a mono uppercase muted label, a large bold
// numeral value, and an optional delta line (teal for up, amber/red for down)
// or a muted hint. Mirrors the Command Center KPI tiles.
export function StatTile({
  label,
  value,
  delta,
  hint,
  valueClassName = "text-ink",
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: { value: ReactNode; direction?: "up" | "down" | "flat" };
  hint?: ReactNode;
  valueClassName?: string;
  className?: string;
}) {
  const dir = delta?.direction ?? "flat";
  const deltaCls =
    dir === "up"
      ? "bg-teal-500/10 text-teal-300"
      : dir === "down"
      ? "bg-amber-500/10 text-amber-300"
      : "bg-charcoal-800 text-ink-muted";

  return (
    <div
      className={`rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate ${className}`}
    >
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className={`mt-2 text-2xl font-bold tracking-tight ${valueClassName}`}>{value}</p>
      {delta ? (
        <p
          className={`mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${deltaCls}`}
        >
          {dir === "up" ? "▲" : dir === "down" ? "▼" : "•"} {delta.value}
        </p>
      ) : hint != null ? (
        <p className="mt-1 text-xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}
