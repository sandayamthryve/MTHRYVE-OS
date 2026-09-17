"use client";

// components/tony/cognitive/DrillDownPanel.tsx — the context-focus drill-down.
// When a node is selected we highlight it + its neighbors in the graph and slide
// this panel in (Framer Motion) with that node's REAL details: owner, its KPIs
// (missing values shown as "—", never faked), status, connected nodes, and a
// link to the node's actual OS page. Nothing here is fabricated.

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import type { TcveNode } from "@/lib/tony/graph-types";
import { STATUS_LABEL, STATUS_RING, TYPE_COLOR, TYPE_LABEL } from "./palette";

export function DrillDownPanel({
  node,
  neighbors,
  onClose,
  onSelectNeighbor,
}: {
  node: TcveNode | null;
  neighbors: TcveNode[];
  onClose: () => void;
  // eslint-disable-next-line no-unused-vars
  onSelectNeighbor: (id: string) => void;
}) {
  return (
    <AnimatePresence>
      {node && (
        <motion.aside
          key={node.id}
          initial={{ x: 32, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 32, opacity: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 32 }}
          className="pointer-events-auto absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[19rem] flex-col overflow-hidden rounded-lg border border-charcoal-700/70 bg-charcoal-900/95 shadow-elevate backdrop-blur"
        >
          {/* Header */}
          <div className="flex items-start gap-3 border-b border-charcoal-700/60 p-4">
            <span
              aria-hidden
              className="mt-0.5 h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: TYPE_COLOR[node.type], boxShadow: `0 0 10px ${TYPE_COLOR[node.type]}` }}
            />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                {TYPE_LABEL[node.type]}
              </p>
              <h3 className="truncate text-sm font-semibold text-ink" title={node.label}>
                {node.label}
              </h3>
              {node.sublabel && <p className="truncate text-xs text-ink-muted">{node.sublabel}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="shrink-0 rounded p-1 text-ink-dim transition-colors hover:bg-charcoal-800 hover:text-ink"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {/* Status + owner */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                style={{ borderColor: `${STATUS_RING[node.status]}66`, color: STATUS_RING[node.status] }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATUS_RING[node.status] }} />
                {STATUS_LABEL[node.status]}
              </span>
              {node.owner && (
                <span className="rounded-full border border-charcoal-700 bg-charcoal-850 px-2 py-0.5 text-[10px] text-ink-muted">
                  Owner: {node.owner}
                </span>
              )}
            </div>

            {/* Real stats */}
            {node.stats.length > 0 && (
              <dl className="mb-4 grid grid-cols-2 gap-2">
                {node.stats.map((s) => (
                  <div key={s.label} className="rounded-md border border-charcoal-700/50 bg-charcoal-850/60 p-2">
                    <dt className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{s.label}</dt>
                    <dd className="mt-0.5 truncate text-xs font-medium text-ink" title={s.value ?? "—"}>
                      {s.value ?? <span className="text-ink-dim">—</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            {/* Recommendation / description meta, when the row exposes it */}
            {typeof node.meta.recommendation === "string" && node.meta.recommendation && (
              <div className="mb-4 rounded-md border border-gold-500/25 bg-gold-500/5 p-2.5">
                <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-gold-400">Recommendation</p>
                <p className="text-xs leading-relaxed text-ink-muted">{node.meta.recommendation}</p>
              </div>
            )}
            {typeof node.meta.description === "string" && node.meta.description && (
              <div className="mb-4 rounded-md border border-charcoal-700/50 bg-charcoal-850/60 p-2.5">
                <p className="text-xs leading-relaxed text-ink-muted">{node.meta.description}</p>
              </div>
            )}

            {/* Neighbors — the context this node sits in */}
            {neighbors.length > 0 && (
              <div className="mb-3">
                <p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-ink-dim">
                  Connected ({neighbors.length})
                </p>
                <div className="flex flex-col gap-1">
                  {neighbors.slice(0, 8).map((nb) => (
                    <button
                      key={nb.id}
                      type="button"
                      onClick={() => onSelectNeighbor(nb.id)}
                      className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left transition-colors hover:border-charcoal-700 hover:bg-charcoal-850"
                    >
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: TYPE_COLOR[nb.type] }}
                      />
                      <span className="truncate text-xs text-ink-muted">{nb.label}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wide text-ink-dim">
                        {TYPE_LABEL[nb.type]}
                      </span>
                    </button>
                  ))}
                  {neighbors.length > 8 && (
                    <p className="px-2 pt-1 text-[10px] text-ink-dim">+{neighbors.length - 8} more</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer: link to the real OS page */}
          {node.href && (
            <div className="border-t border-charcoal-700/60 p-3">
              <Link
                href={node.href}
                className="flex items-center justify-center gap-1.5 rounded-md bg-gradient-to-b from-teal-400 to-teal-500 px-3 py-2 text-sm font-medium text-charcoal-950 shadow-glow transition hover:brightness-110"
              >
                Open in OS →
              </Link>
            </div>
          )}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
