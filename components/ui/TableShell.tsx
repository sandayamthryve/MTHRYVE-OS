import type { ReactNode } from "react";

// Consistent table chrome: a bordered, elevated surface wrapping a full-width
// table with the Command Center header row (mono uppercase muted). Callers keep
// full control of their own rows/columns — pass the header labels via `columns`
// and the <tr> rows as children. Use `rowClass` on each row for matching
// borders + hover.
export const rowClass = "border-b border-charcoal-700/60 hover:bg-charcoal-800/40";

export function TableShell({
  columns,
  children,
  className = "",
}: {
  columns: ReactNode[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-x-auto rounded-xl border border-charcoal-700/60 bg-charcoal-900 shadow-elevate ${className}`}
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-charcoal-700/60 text-left font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            {columns.map((c, i) => (
              <th key={i} className="p-3 font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
