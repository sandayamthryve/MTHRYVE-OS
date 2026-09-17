"use client";

// components/tony/cognitive/CommandBar.tsx — the search / command surface.
// Type a name (or "analyze <brand>", "focus <department>") to jump the graph to
// that node: it centers, focuses (highlight + neighbors, fade the rest) and
// opens its drill-down. Suggestions are the REAL node labels only — it can only
// find something that actually exists in the graph.

import { useMemo, useRef, useState } from "react";
import type { TcveNode } from "@/lib/tony/graph-types";
import { TYPE_COLOR, TYPE_LABEL } from "./palette";

const VERB = /^\s*(analy[sz]e|focus|show|find|open|go to)\s+/i;

export function CommandBar({
  nodes,
  onFocus,
}: {
  nodes: TcveNode[];
  // eslint-disable-next-line no-unused-vars
  onFocus: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = q.replace(VERB, "").trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    return nodes
      .filter((n) => n.label.toLowerCase().includes(query) || (n.sublabel ?? "").toLowerCase().includes(query))
      .slice(0, 8);
  }, [nodes, query]);

  const choose = (n: TcveNode | undefined) => {
    if (!n) return;
    onFocus(n.id);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="relative w-full max-w-md">
      <div className="flex items-center gap-2 rounded-lg border border-charcoal-700/70 bg-charcoal-900/80 px-3 py-2 focus-within:border-teal-500/60">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="shrink-0 text-ink-dim">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              choose(results[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder='Analyze a node — "analyze Acme", "focus Growth"…'
          className="w-full bg-transparent text-sm text-ink placeholder:text-ink-dim focus:outline-none"
          aria-label="Search and focus a graph node"
        />
      </div>

      {open && results.length > 0 && (
        <ul className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-lg border border-charcoal-700/70 bg-charcoal-900/95 shadow-elevate backdrop-blur">
          {results.map((n, i) => (
            <li key={n.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(n);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  i === active ? "bg-charcoal-800" : "hover:bg-charcoal-850"
                }`}
              >
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: TYPE_COLOR[n.type] }} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{n.label}</span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-ink-dim">{TYPE_LABEL[n.type]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && query && results.length === 0 && (
        <div className="absolute z-30 mt-1.5 w-full rounded-lg border border-charcoal-700/70 bg-charcoal-900/95 px-3 py-2 text-xs text-ink-dim shadow-elevate">
          No node matches “{query}”.
        </div>
      )}
    </div>
  );
}
