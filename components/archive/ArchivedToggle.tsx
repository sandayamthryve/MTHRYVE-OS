import Link from "next/link";

// components/archive/ArchivedToggle.tsx — the per-cluster switch between the
// default (active) list and the Archived view. A plain server component: two
// links that flip the `archived` query flag while preserving any other query
// params the page cares about (window, brand, tab, …). The page decides what to
// preserve; this component just renders the pill pair.

function buildHref(basePath: string, params: Record<string, string>, archived: boolean): string {
  const sp = new URLSearchParams(params);
  if (archived) sp.set("archived", "1");
  else sp.delete("archived");
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function ArchivedToggle({
  basePath,
  archived,
  params = {},
  archivedLabel = "Archived",
  activeLabel = "Active",
}: {
  basePath: string;
  archived: boolean;
  params?: Record<string, string>;
  archivedLabel?: string;
  activeLabel?: string;
}) {
  const base = "rounded-full px-3 py-1 text-xs font-medium transition-colors";
  const on = "bg-teal-500/15 text-teal-200 ring-1 ring-teal-500/40";
  const off = "bg-charcoal-800 text-ink-muted ring-1 ring-charcoal-700 hover:text-ink";
  return (
    <div className="inline-flex items-center gap-1.5" role="tablist" aria-label="Archive filter">
      <Link href={buildHref(basePath, params, false)} className={`${base} ${archived ? off : on}`} role="tab" aria-selected={!archived}>
        {activeLabel}
      </Link>
      <Link href={buildHref(basePath, params, true)} className={`${base} ${archived ? on : off}`} role="tab" aria-selected={archived}>
        {archivedLabel}
      </Link>
    </div>
  );
}
