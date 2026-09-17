"use client";

// QuickEntryLauncher — the button + modal that opens the ONE canonical Quick
// Entry surface: the FULL-department grid (QuickEntryGrid), the same component
// the standalone /quick-entry page renders. There is no longer a separate
// one-metric-at-a-time (pick → snap → confirm) flow; both entry points show the
// same grid and save through the same /api/quick-entry/bulk path.
//
// The scope (who may enter for which team + the manual-metric catalog) is
// resolved server-side by resolveManualCatalogScope and fetched here once from
// /api/metrics/catalog — the SAME endpoint/resolver the standalone page uses — so
// the two surfaces can never diverge. `defaultDepartment` (a metrics-floor CODE,
// e.g. "ecommerce") preselects the team the launcher was opened for.

import { useEffect, useState } from "react";
import { QuickEntryGrid, type GridMetric } from "./QuickEntryGrid";

interface CatalogScope {
  canPickDepartment: boolean;
  department: string | null; // the caller's own department CODE (locked callers)
  departments: string[];
  catalog: GridMetric[];
}

export function QuickEntryLauncher({
  defaultDepartment = null,
  className = "",
}: {
  defaultDepartment?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-charcoal-950 shadow-elevate transition-colors hover:bg-teal-400"
      >
        <span aria-hidden className="text-base">⚡</span> Quick Entry
      </button>

      {open && <QuickEntrySheet defaultDepartment={defaultDepartment} onClose={() => setOpen(false)} />}
    </div>
  );
}

function QuickEntrySheet({
  defaultDepartment,
  onClose,
}: {
  defaultDepartment: string | null;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<CatalogScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Load the caller's hand-enterable (lane='manual') catalog + scope ONCE. The
  // server decides the slice from the signed-in profile (leadership / anyone with
  // no department → every team; everyone else → their own).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch("/api/metrics/catalog")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("catalog"))))
      .then((data: CatalogScope) => {
        if (!cancelled) setScope(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center sm:items-start sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-label="Quick entry"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-charcoal-950/70 backdrop-blur-sm"
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-5 shadow-elevate sm:h-auto sm:max-h-[88vh] sm:rounded-2xl sm:border">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Quick Entry</h2>
            <p className="mt-0.5 text-[11px] text-ink-muted">
              Type a number on each line and save — blanks are left as “—”.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-charcoal-700 px-2.5 py-1.5 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
          >
            Close
          </button>
        </div>

        {error ? (
          <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-3 text-sm text-red-300">
            Couldn&apos;t load metrics — check your connection and reopen.
          </p>
        ) : loading || !scope ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900/60 px-3 py-6 text-center text-sm text-ink-dim">
            Loading…
          </div>
        ) : (
          <QuickEntryGrid
            canPickDepartment={scope.canPickDepartment}
            departments={scope.departments}
            ownDepartment={scope.department}
            catalog={scope.catalog}
            initialDepartment={defaultDepartment}
          />
        )}
      </aside>
    </div>
  );
}
