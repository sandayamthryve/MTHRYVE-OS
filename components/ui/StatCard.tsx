// Compact metric card used across dashboards. Value is rendered in the mono
// face (reserved for metrics/IDs per the design tokens) so numbers line up and
// read as data, not prose.
export function StatCard({
  label,
  value,
  hint,
  accent = "teal",
}: {
  label: string;
  value: string | number;
  hint?: string;
  accent?: "teal" | "green" | "gold";
}) {
  const accentClass =
    accent === "green" ? "text-green-400" : accent === "gold" ? "text-gold-400" : "text-teal-400";

  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-medium ${accentClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}
