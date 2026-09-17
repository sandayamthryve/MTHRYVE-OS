import Link from "next/link";
import type { ReactNode } from "react";

// A clickable KPI card for the Warehouse Overview. Same visual language as
// StatTile, but the whole card is a link into the module the metric drills into.
// Purely presentational — the caller passes the derived value and destination.
export function StatLink({
  label,
  value,
  hint,
  href,
  valueClassName = "text-ink",
  disabled = false,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  href: string;
  valueClassName?: string;
  disabled?: boolean;
}) {
  const body = (
    <div
      className={`group h-full rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate transition-colors ${
        disabled ? "opacity-60" : "hover:border-teal-500/40 hover:bg-charcoal-800/60"
      }`}
    >
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className={`mt-2 text-2xl font-bold tracking-tight ${valueClassName}`}>{value}</p>
      {hint != null ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
    </div>
  );
  if (disabled) return body;
  return (
    <Link href={href} className="block">
      {body}
    </Link>
  );
}
