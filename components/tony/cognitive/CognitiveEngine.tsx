"use client";

// components/tony/cognitive/CognitiveEngine.tsx — the Tony Cognitive
// Visualization Engine (TCVE). Orchestrates the living enterprise graph: the
// force canvas (Tony pinned center), context-focus + drill-down, the search /
// command bar, progressive disclosure (expand a department / the knowledge hub
// to reveal children), the "watch Tony think" reasoning trace, and minimal live
// updates. Every node/edge comes from the REAL, RLS-scoped graph API — this
// component only renders and animates it; it never fabricates data.

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TcveGraph, TcveNode, TcveEdge } from "@/lib/tony/graph-types";
import { ForceGraphCanvas } from "./ForceGraphCanvas";
import { DrillDownPanel } from "./DrillDownPanel";
import { ReasoningTrace } from "./ReasoningTrace";
import { CommandBar } from "./CommandBar";
import { useGraphRealtime, type GraphRealtimeEvent } from "./useGraphRealtime";
import { LEGEND_TYPES, TYPE_COLOR, TYPE_LABEL } from "./palette";

type GNode = TcveNode & { x?: number; y?: number; fx?: number; fy?: number };

function isVisible(node: TcveNode, expanded: Set<string>): boolean {
  if (!node.hiddenByDefault) return true;
  return node.parentId != null && expanded.has(node.parentId);
}

export function CognitiveEngine({ initialGraph }: { initialGraph: TcveGraph }) {
  const [graph, setGraph] = useState<TcveGraph>(initialGraph);

  // Progressive disclosure: departments + growth pods start expanded (structure
  // visible); the knowledge hub starts collapsed (its docs clustered) so the
  // graph reads cleanly and scales to hundreds of nodes.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const n of initialGraph.nodes) {
      if (n.collapsible && (n.type === "department" || n.type === "pod")) s.add(n.id);
    }
    return s;
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<Array<{ id: string; text: string }>>([]);

  const fgRef = useRef<any>(null);
  const nodeMapRef = useRef<Map<string, GNode>>(new Map());
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable graph-node objects: reuse the same object per id across renders so the
  // force sim's x/y positions survive data refreshes and expand/collapse.
  const allNodes = useMemo(() => {
    const map = nodeMapRef.current;
    const seen = new Set<string>();
    const out: GNode[] = [];
    for (const tn of graph.nodes) {
      seen.add(tn.id);
      const existing = map.get(tn.id);
      if (existing) {
        Object.assign(existing, tn); // refresh data fields; x/y/fx/fy preserved
        out.push(existing);
      } else {
        const g = { ...tn } as GNode;
        map.set(tn.id, g);
        out.push(g);
      }
    }
    for (const id of Array.from(map.keys())) if (!seen.has(id)) map.delete(id);
    return out;
  }, [graph]);

  const visibleNodes = useMemo(
    () => allNodes.filter((n) => isVisible(n, expanded)),
    [allNodes, expanded]
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const visibleLinks = useMemo(
    () =>
      graph.edges
        .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
        .map((e) => ({ ...e, source: e.source, target: e.target })) as (TcveEdge & {
        source: string;
        target: string;
      })[],
    [graph.edges, visibleIds]
  );

  // Neighbor + focus sets for context-focus (highlight selected + neighbors,
  // fade the rest). Computed from ALL edges so hidden neighbors still list.
  const neighborIds = useCallback(
    (id: string): Set<string> => {
      const set = new Set<string>();
      for (const e of graph.edges) {
        if (e.source === id) set.add(e.target);
        else if (e.target === id) set.add(e.source);
      }
      return set;
    },
    [graph.edges]
  );

  const { highlightNodeIds, highlightLinkIds } = useMemo(() => {
    const hn = new Set<string>();
    const hl = new Set<string>();
    if (selectedId) {
      hn.add(selectedId);
      for (const nb of neighborIds(selectedId)) hn.add(nb);
      for (const e of graph.edges) {
        if (e.source === selectedId || e.target === selectedId) hl.add(e.id);
      }
    }
    // Flash (live events) also glow briefly.
    for (const f of flash) hn.add(f);
    return { highlightNodeIds: hn, highlightLinkIds: hl };
  }, [selectedId, flash, neighborIds, graph.edges]);

  const selectedNode = useMemo(
    () => (selectedId ? graph.nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, graph.nodes]
  );
  const selectedNeighbors = useMemo(() => {
    if (!selectedId) return [];
    const ids = neighborIds(selectedId);
    return graph.nodes.filter((n) => ids.has(n.id));
  }, [selectedId, neighborIds, graph.nodes]);

  const centerOn = useCallback((id: string) => {
    const g = nodeMapRef.current.get(id);
    const fg = fgRef.current;
    if (fg && g && typeof g.x === "number" && typeof g.y === "number") {
      try {
        fg.centerAt(g.x, g.y, 600);
        const z = fg.zoom?.();
        if (typeof z === "number" && z < 1.4) fg.zoom(1.6, 600);
      } catch {
        /* noop */
      }
    }
  }, []);

  const selectNode = useCallback(
    (id: string) => {
      const node = graph.nodes.find((n) => n.id === id);
      if (!node) return;
      // Reveal a hidden node by expanding its parent first.
      if (node.hiddenByDefault && node.parentId) {
        setExpanded((prev) => {
          if (prev.has(node.parentId!)) return prev;
          const next = new Set(prev);
          next.add(node.parentId!);
          return next;
        });
      }
      setSelectedId(id);
      setTimeout(() => centerOn(id), 60);
    },
    [graph.nodes, centerOn]
  );

  const onNodeClick = useCallback(
    (id: string) => {
      const node = graph.nodes.find((n) => n.id === id);
      if (!node) return;
      // Collapsible nodes (department / knowledge hub) toggle their children AND
      // focus. Everything else just focuses.
      if (node.collapsible) {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }
      setSelectedId(id);
      setTimeout(() => centerOn(id), 60);
    },
    [graph.nodes, centerOn]
  );

  // Debounced refetch of the real graph after a live event so counts/nodes stay
  // truthful (e.g. a new approval node actually appears).
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/tony/graph", { cache: "no-store" });
        if (res.ok) setGraph((await res.json()) as TcveGraph);
      } catch {
        /* keep the current graph on a failed refresh */
      }
    }, 1200);
  }, []);

  const flashNode = useCallback((id: string) => {
    setFlash((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setFlash((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 4000);
  }, []);

  const onRealtime = useCallback(
    (ev: GraphRealtimeEvent) => {
      let text = "";
      if (ev.kind === "approval_created") {
        const id = `approval:${String(ev.row.id)}`;
        flashNode(id);
        text = `New approval: ${String(ev.row.title ?? "request")}`;
      } else if (ev.kind === "task_completed") {
        if (ev.row.brand_id) flashNode(`brand:${String(ev.row.brand_id)}`);
        text = `Task completed: ${String(ev.row.title ?? "task")}`;
      } else {
        if (ev.row.brand_id) flashNode(`brand:${String(ev.row.brand_id)}`);
        text = `Task updated: ${String(ev.row.title ?? "task")}`;
      }
      const eid = `${ev.table}:${String(ev.row.id)}:${Date.now()}`;
      setEvents((prev) => [{ id: eid, text }, ...prev].slice(0, 4));
      setTimeout(() => setEvents((prev) => prev.filter((e) => e.id !== eid)), 6000);
      scheduleRefetch();
    },
    [flashNode, scheduleRefetch]
  );

  useGraphRealtime(true, onRealtime);

  const counts = graph.meta.counts;

  return (
    <div className="flex flex-col gap-4">
      {/* Header: title, live counts, search */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-ink">Tony · Cognitive Engine</h2>
              <span className="flex items-center gap-1.5 rounded-full border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-400" />
                </span>
                Live
              </span>
            </div>
            <p className="text-sm text-ink-muted">
              A living map of the organization — Tony at the center, every node a real record.
              Click to focus &amp; drill in; expand a department or the knowledge hub to reveal more.
            </p>
          </div>
          <CommandBar nodes={visibleNodes} onFocus={selectNode} />
        </div>

        {/* Legend + counts */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-charcoal-700/50 bg-charcoal-900/40 px-3 py-2">
          {LEGEND_TYPES.filter((t) => (counts[t] ?? 0) > 0).map((t) => (
            <span key={t} className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: TYPE_COLOR[t] }} />
              {TYPE_LABEL[t]}
              <span className="text-ink-dim">{counts[t]}</span>
            </span>
          ))}
          <span className="ml-auto font-mono text-[10px] text-ink-dim">
            {visibleNodes.length} shown · {graph.nodes.length} total nodes
          </span>
        </div>
      </div>

      {/* Graph + reasoning trace */}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="relative h-[68vh] min-h-[420px] overflow-hidden rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900/60 to-obsidian shadow-elevate">
          <ForceGraphCanvas
            nodes={visibleNodes}
            links={visibleLinks}
            highlightNodeIds={highlightNodeIds}
            highlightLinkIds={highlightLinkIds}
            hoverNodeId={hoverId}
            selectedNodeId={selectedId}
            centerId={graph.meta.centerId}
            onNodeClick={onNodeClick}
            onNodeHover={setHoverId}
            onBackgroundClick={() => setSelectedId(null)}
            onReady={(m) => (fgRef.current = m)}
          />

          {/* Focus / interaction hint */}
          {!selectedId && (
            <div className="pointer-events-none absolute bottom-3 left-3 max-w-[16rem] rounded-md border border-charcoal-700/50 bg-charcoal-900/70 px-2.5 py-1.5 font-mono text-[10px] text-ink-dim backdrop-blur">
              Click a node to focus · drag to reposition · scroll to zoom
            </div>
          )}

          {/* Live event toasts */}
          <div className="pointer-events-none absolute left-3 top-14 z-20 flex flex-col gap-1.5">
            <AnimatePresence>
              {events.map((e) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  className="rounded-md border border-teal-500/30 bg-charcoal-900/90 px-2.5 py-1.5 text-[11px] text-teal-200 shadow-elevate"
                >
                  ⚡ {e.text}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* Context-focus drill-down */}
          <DrillDownPanel
            node={selectedNode}
            neighbors={selectedNeighbors}
            onClose={() => setSelectedId(null)}
            onSelectNeighbor={selectNode}
          />
        </div>

        {/* Reasoning trace */}
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-900/60 p-4 shadow-elevate">
          <ReasoningTrace stages={graph.pipeline} focusLabel={selectedNode?.label ?? null} />
        </div>
      </div>
    </div>
  );
}
