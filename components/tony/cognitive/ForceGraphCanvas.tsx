"use client";

// components/tony/cognitive/ForceGraphCanvas.tsx — measures its container and
// hosts the react-force-graph-2d canvas (dynamically imported with ssr:false,
// because the library touches `window` at import time) plus the mini-map
// overlay + zoom controls. Owns nothing about the DATA — it just renders the
// visible node/link set it's given and forwards interactions up.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TcveNode, TcveEdge } from "@/lib/tony/graph-types";
import type { ForceGraphInnerProps } from "./ForceGraphInner";
import { MiniMap } from "./MiniMap";

const ForceGraphInner = dynamic(() => import("./ForceGraphInner"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-ink-dim">
      Initializing cognitive graph…
    </div>
  ),
});

type GNode = TcveNode & { x?: number; y?: number };

type CanvasProps = Omit<ForceGraphInnerProps, "width" | "height" | "innerRef"> & {
  nodes: GNode[];
  // eslint-disable-next-line no-unused-vars
  onReady?: (methods: unknown) => void;
};

export function ForceGraphCanvas(props: CanvasProps) {
  const { onReady, ...inner } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const nodesRef = useRef<GNode[]>(props.nodes);
  nodesRef.current = props.nodes;

  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setSize({ w: Math.floor(cr.width), h: Math.floor(cr.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const setInstance = useCallback((methods: unknown) => {
    fgRef.current = methods;
    onReadyRef.current?.(methods);
  }, []);

  const zoomBy = (factor: number) => {
    const fg = fgRef.current;
    if (!fg?.zoom) return;
    try {
      const z = fg.zoom();
      fg.zoom(z * factor, 300);
    } catch {
      /* noop */
    }
  };
  const fit = () => {
    try {
      fgRef.current?.zoomToFit(500, 90);
    } catch {
      /* noop */
    }
  };

  return (
    <div ref={containerRef} className="relative h-full w-full">
      {size.w > 0 && size.h > 0 && (
        <ForceGraphInner
          {...inner}
          links={inner.links as (TcveEdge & { source: string | GNode; target: string | GNode })[]}
          width={size.w}
          height={size.h}
          innerRef={setInstance}
        />
      )}

      {/* Zoom / fit controls. */}
      <div className="absolute left-3 top-3 flex flex-col gap-1">
        {[
          { label: "+", fn: () => zoomBy(1.4), aria: "Zoom in" },
          { label: "−", fn: () => zoomBy(1 / 1.4), aria: "Zoom out" },
          { label: "⤢", fn: fit, aria: "Fit to view" },
        ].map((b) => (
          <button
            key={b.aria}
            type="button"
            onClick={b.fn}
            aria-label={b.aria}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-charcoal-700/70 bg-charcoal-900/80 text-sm text-ink-muted transition-colors hover:border-teal-500/50 hover:text-teal-300"
          >
            {b.label}
          </button>
        ))}
      </div>

      {size.w > 0 && <MiniMap nodesRef={nodesRef} fgRef={fgRef} mainWidth={size.w} mainHeight={size.h} />}
    </div>
  );
}
