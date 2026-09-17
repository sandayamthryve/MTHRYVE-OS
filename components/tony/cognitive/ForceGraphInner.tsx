"use client";

// components/tony/cognitive/ForceGraphInner.tsx — the react-force-graph-2d
// canvas itself. This module is ONLY ever loaded through a dynamic import with
// { ssr: false } (see ForceGraphCanvas.tsx), because the underlying force-graph
// library touches `window`/`canvas` at import time and cannot run during SSR.
//
// It owns all canvas drawing: premium dark/teal nodes with a type-colored fill,
// a status glow ring, a soft "active" pulse, hover/focus highlighting with the
// rest of the graph faded, and subtle energy particles flowing along animated
// edges (Tony ↔ his agents, live approvals, running workflows). Tony is pinned
// at the origin. No number is ever animated — only the visuals.

import { useEffect, useMemo, useRef } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { TcveNode, TcveEdge } from "@/lib/tony/graph-types";
import { TYPE_COLOR, TYPE_RADIUS, STATUS_RING, TYPE_GLYPH, withAlpha } from "./palette";

type GNode = TcveNode & { x?: number; y?: number; fx?: number; fy?: number };
type GLink = TcveEdge & { source: string | GNode; target: string | GNode };

export interface ForceGraphInnerProps {
  nodes: GNode[];
  links: GLink[];
  width: number;
  height: number;
  highlightNodeIds: Set<string>; // focus set (selected + neighbors); empty = no dimming
  highlightLinkIds: Set<string>;
  hoverNodeId: string | null;
  selectedNodeId: string | null;
  centerId: string;
  // eslint-disable-next-line no-unused-vars
  onNodeClick: (id: string) => void;
  // eslint-disable-next-line no-unused-vars
  onNodeHover: (id: string | null) => void;
  onBackgroundClick: () => void;
  // eslint-disable-next-line no-unused-vars
  innerRef: (methods: unknown) => void;
}

const linkEndId = (e: string | GNode): string => (typeof e === "object" ? String(e.id) : String(e));

export default function ForceGraphInner(props: ForceGraphInnerProps) {
  const {
    nodes,
    links,
    width,
    height,
    highlightNodeIds,
    highlightLinkIds,
    hoverNodeId,
    selectedNodeId,
    centerId,
    onNodeClick,
    onNodeHover,
    onBackgroundClick,
    innerRef,
  } = props;

  const fgRef = useRef<any>(null);

  // Hand the imperative instance (centerAt / zoom / zoomToFit) up to the parent.
  useEffect(() => {
    if (fgRef.current) innerRef(fgRef.current);
  }, [innerRef]);

  // Pin Tony at the origin so the whole constellation orbits the brain, and tune
  // the layout forces for a calm, readable spread. Re-applied whenever the
  // visible node set changes (progressive disclosure adds/removes nodes).
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const tony = nodes.find((n) => n.id === centerId);
    if (tony) {
      tony.fx = 0;
      tony.fy = 0;
    }
    try {
      fg.d3Force("charge")?.strength((n: GNode) => (n.id === centerId ? -1200 : -260));
      fg.d3Force("link")?.distance((l: GLink) => {
        const s = linkEndId(l.source);
        const t = linkEndId(l.target);
        if (s === centerId || t === centerId) return 130;
        return 60;
      });
      fg.d3Force("center")?.strength(0.05);
    } catch {
      /* forces not ready yet — the next data change re-applies them */
    }
    // Fit once shortly after the sim warms up.
    const id = setTimeout(() => {
      try {
        fg.zoomToFit(600, 90);
      } catch {
        /* noop */
      }
    }, 400);
    return () => clearTimeout(id);
  }, [nodes, links, centerId]);

  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);
  const focusing = highlightNodeIds.size > 0;

  // A time phase (0..1) for the "active" pulse; recomputed each frame from the
  // wall clock so the pulse animates smoothly without React re-renders.
  const pulse = () => ((performance.now() / 1400) % 1);

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={graphData as any}
      width={width}
      height={height}
      backgroundColor="rgba(0,0,0,0)"
      nodeId="id"
      nodeRelSize={1}
      cooldownTicks={120}
      d3VelocityDecay={0.28}
      warmupTicks={20}
      enableNodeDrag
      onNodeClick={(n: any) => onNodeClick(String(n.id))}
      onNodeHover={(n: any) => onNodeHover(n ? String(n.id) : null)}
      onBackgroundClick={onBackgroundClick}
      onNodeDragEnd={(n: any) => {
        // Keep a dragged node where the user dropped it (except Tony, always centered).
        if (String(n.id) !== centerId) {
          n.fx = n.x;
          n.fy = n.y;
        }
      }}
      linkColor={(l: any) => {
        const active = highlightLinkIds.has(String(l.id));
        if (focusing && !active) return "rgba(120,140,150,0.05)";
        return active ? withAlpha("#5FD8CF", 0.55) : "rgba(120,140,150,0.16)";
      }}
      linkWidth={(l: any) => (highlightLinkIds.has(String(l.id)) ? 1.6 : 0.6)}
      linkDirectionalParticles={(l: any) => {
        if (focusing && !highlightLinkIds.has(String(l.id))) return 0;
        return l.animated ? 2 : 0;
      }}
      linkDirectionalParticleWidth={2}
      linkDirectionalParticleSpeed={0.006}
      linkDirectionalParticleColor={(l: any) =>
        highlightLinkIds.has(String(l.id)) ? "#5FD8CF" : withAlpha("#4BC0B8", 0.7)
      }
      nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const r = TYPE_RADIUS[(node as GNode).type] ?? 7;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
        ctx.fill();
      }}
      nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const n = node as GNode;
        const base = TYPE_COLOR[n.type] ?? "#4BC0B8";
        const ring = STATUS_RING[n.status] ?? "#3A464C";
        const r = TYPE_RADIUS[n.type] ?? 7;
        const isHi = highlightNodeIds.has(n.id);
        const isHover = hoverNodeId === n.id;
        const isSelected = selectedNodeId === n.id;
        const dim = focusing && !isHi;
        const alpha = dim ? 0.16 : 1;
        const x = n.x ?? 0;
        const y = n.y ?? 0;

        ctx.save();
        ctx.globalAlpha = alpha;

        // Soft "active" pulse ring for live nodes (approvals, running workflows,
        // busy brands). Purely decorative recency signal.
        if ((n.active || isSelected) && !dim) {
          const p = pulse();
          const pr = r + 3 + p * (r * 1.1);
          ctx.beginPath();
          ctx.arc(x, y, pr, 0, 2 * Math.PI);
          ctx.strokeStyle = withAlpha(base, (1 - p) * 0.45);
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }

        // Ambient glow behind highlighted / hovered / active nodes.
        if (isHi || isHover || n.active) {
          const grd = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 2.4);
          grd.addColorStop(0, withAlpha(base, 0.5));
          grd.addColorStop(1, withAlpha(base, 0));
          ctx.beginPath();
          ctx.arc(x, y, r * 2.4, 0, 2 * Math.PI);
          ctx.fillStyle = grd;
          ctx.fill();
        }

        // Status ring.
        ctx.beginPath();
        ctx.arc(x, y, r + 1.6, 0, 2 * Math.PI);
        ctx.strokeStyle = ring;
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // Body.
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = base;
        ctx.fill();

        // Inner highlight for depth.
        const ig = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
        ig.addColorStop(0, "rgba(255,255,255,0.35)");
        ig.addColorStop(1, "rgba(255,255,255,0)");
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = ig;
        ctx.fill();

        // Selected / hovered outline.
        if (isSelected || isHover) {
          ctx.beginPath();
          ctx.arc(x, y, r + 3.2, 0, 2 * Math.PI);
          ctx.strokeStyle = isSelected ? "#E8ECEC" : withAlpha("#E8ECEC", 0.6);
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }

        // Glyph inside large nodes.
        const glyph = TYPE_GLYPH[n.type];
        if (glyph && r >= 11) {
          ctx.fillStyle = "#0B0F11";
          ctx.font = `${Math.round(r * 0.9)}px var(--font-display, sans-serif)`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(glyph, x, y + 0.5);
        }

        // Label: always for Tony/hubs; for the rest only when zoomed in, hovered,
        // or in focus — keeps a hundreds-of-nodes graph legible.
        const showLabel =
          n.type === "brain" ||
          n.type === "knowledge_hub" ||
          isHover ||
          isSelected ||
          (isHi && globalScale > 0.9) ||
          globalScale > 1.7;
        if (showLabel && !dim) {
          const fontSize = Math.max(3, (n.type === "brain" ? 13 : 10) / globalScale);
          ctx.font = `${fontSize}px var(--font-body, sans-serif)`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          const label = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
          const ty = y + r + 2.5;
          // Legibility plate.
          const w = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(11,15,17,0.72)";
          ctx.fillRect(x - w / 2 - 2, ty - 0.5, w + 4, fontSize + 2);
          ctx.fillStyle = isHover || isSelected ? "#E8ECEC" : "#93A1A1";
          ctx.fillText(label, x, ty);
        }

        ctx.restore();
      }}
    />
  );
}
