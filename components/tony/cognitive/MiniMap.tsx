"use client";

// components/tony/cognitive/MiniMap.tsx — a lightweight overview of the whole
// graph drawn from the SAME live node objects the force sim mutates, plus a
// viewport rectangle read from the graph instance (zoom + center). Repaints on
// a requestAnimationFrame loop so it tracks pan/zoom/layout in real time.
// Click-to-recenter jumps the main graph to that spot.

import { useEffect, useRef } from "react";
import type { TcveNode } from "@/lib/tony/graph-types";
import { TYPE_COLOR } from "./palette";

type GNode = TcveNode & { x?: number; y?: number };

const MW = 160;
const MH = 110;
const PAD = 8;

export function MiniMap({
  nodesRef,
  fgRef,
  mainWidth,
  mainHeight,
}: {
  nodesRef: React.MutableRefObject<GNode[]>;
  fgRef: React.MutableRefObject<any>;
  mainWidth: number;
  mainHeight: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef({ scale: 1, ox: 0, oy: 0 });

  useEffect(() => {
    let raf = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = MW * dpr;
    canvas.height = MH * dpr;
    ctx.scale(dpr, dpr);

    const draw = () => {
      const nodes = nodesRef.current.filter((n) => typeof n.x === "number" && typeof n.y === "number");
      ctx.clearRect(0, 0, MW, MH);
      ctx.fillStyle = "rgba(11,15,17,0.85)";
      ctx.fillRect(0, 0, MW, MH);

      if (nodes.length > 0) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const n of nodes) {
          minX = Math.min(minX, n.x!);
          maxX = Math.max(maxX, n.x!);
          minY = Math.min(minY, n.y!);
          maxY = Math.max(maxY, n.y!);
        }
        const spanX = Math.max(1, maxX - minX);
        const spanY = Math.max(1, maxY - minY);
        const scale = Math.min((MW - PAD * 2) / spanX, (MH - PAD * 2) / spanY);
        const ox = PAD - minX * scale + ((MW - PAD * 2 - spanX * scale) / 2);
        const oy = PAD - minY * scale + ((MH - PAD * 2 - spanY * scale) / 2);
        transformRef.current = { scale, ox, oy };

        for (const n of nodes) {
          const px = n.x! * scale + ox;
          const py = n.y! * scale + oy;
          ctx.beginPath();
          ctx.arc(px, py, n.type === "brain" ? 2.6 : 1.4, 0, 2 * Math.PI);
          ctx.fillStyle = TYPE_COLOR[n.type] ?? "#4BC0B8";
          ctx.fill();
        }

        // Viewport rectangle (main canvas edges → graph coords → minimap coords).
        const fg = fgRef.current;
        if (fg?.screen2GraphCoords) {
          try {
            const tl = fg.screen2GraphCoords(0, 0);
            const br = fg.screen2GraphCoords(mainWidth, mainHeight);
            const rx = tl.x * scale + ox;
            const ry = tl.y * scale + oy;
            const rw = (br.x - tl.x) * scale;
            const rh = (br.y - tl.y) * scale;
            ctx.strokeStyle = "rgba(95,216,207,0.8)";
            ctx.lineWidth = 1;
            ctx.strokeRect(rx, ry, rw, rh);
          } catch {
            /* coords not ready */
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [nodesRef, fgRef, mainWidth, mainHeight]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const fg = fgRef.current;
    if (!canvas || !fg?.centerAt) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { scale, ox, oy } = transformRef.current;
    const gx = (mx - ox) / scale;
    const gy = (my - oy) / scale;
    fg.centerAt(gx, gy, 500);
  };

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 overflow-hidden rounded-md border border-charcoal-700/70 shadow-elevate">
      <div className="border-b border-charcoal-700/50 bg-charcoal-900/80 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-ink-dim">
        Mini-map
      </div>
      <canvas
        ref={canvasRef}
        onClick={onClick}
        style={{ width: MW, height: MH, cursor: "pointer", display: "block" }}
        aria-label="Graph mini-map — click to recenter"
      />
    </div>
  );
}
