"use client";

// components/tony/cognitive/ReasoningTrace.tsx — "watch Tony think". This
// visualizes Tony's ACTUAL request pipeline (the Anthropic agentic tool-use loop
// in app/api/assistant/route.ts) as ordered stages. The stage list + the
// caller-scoped real facts per stage (docs available for RAG, skills/workflows
// visible, your model tier, your execution gating) come straight from the graph
// API — buildPipeline() in lib/tony/graph.ts. This is a visualization of the
// REAL process; it does not fabricate a run or invent intermediate data.
//
// "Trace" plays the stages in sequence (a visual walkthrough), lighting each up
// with a spring so you can watch the flow. It never calls the live model — it
// illustrates the pipeline the model runs through, grounded in your real config.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { TcvePipelineStage } from "@/lib/tony/graph-types";

const STATUS_STYLE: Record<TcvePipelineStage["status"], { dot: string; label: string }> = {
  ready: { dot: "#4CAF6D", label: "always runs" },
  conditional: { dot: "#4BC0B8", label: "conditional" },
  gated: { dot: "#D4A94B", label: "role-gated" },
};

export function ReasoningTrace({
  stages,
  focusLabel,
}: {
  stages: TcvePipelineStage[];
  focusLabel: string | null;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const play = () => {
    clearTimers();
    setPlaying(true);
    setActiveIndex(-1);
    stages.forEach((_, i) => {
      timers.current.push(
        setTimeout(() => {
          setActiveIndex(i);
          if (i === stages.length - 1) {
            timers.current.push(setTimeout(() => setPlaying(false), 700));
          }
        }, 420 * (i + 1))
      );
    });
  };

  useEffect(() => () => clearTimers(), []);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Reasoning trace</h3>
          <p className="text-[11px] text-ink-muted">
            Tony&apos;s real pipeline
            {focusLabel ? (
              <>
                {" "}·{" "}
                <span className="text-teal-300">analyzing {focusLabel}</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={play}
          className="shrink-0 rounded-md border border-teal-500/40 bg-teal-500/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-teal-300 transition hover:bg-teal-500/20"
        >
          {playing ? "Tracing…" : "▶ Trace"}
        </button>
      </div>

      <ol className="relative flex-1 space-y-0 overflow-y-auto pr-1">
        {/* Spine */}
        <span aria-hidden className="absolute bottom-2 left-[7px] top-2 w-px bg-charcoal-700/60" />
        {stages.map((stage, i) => {
          const reached = !playing || i <= activeIndex;
          const isActive = playing && i === activeIndex;
          const st = STATUS_STYLE[stage.status];
          return (
            <li key={stage.key} className="relative flex gap-3 pb-3 pl-0">
              <div className="relative z-10 mt-0.5 flex flex-col items-center">
                <motion.span
                  aria-hidden
                  animate={{
                    scale: isActive ? 1.5 : 1,
                    boxShadow: isActive ? `0 0 12px ${st.dot}` : "0 0 0px transparent",
                  }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                  className="h-3.5 w-3.5 rounded-full border-2"
                  style={{
                    borderColor: st.dot,
                    backgroundColor: reached ? st.dot : "transparent",
                    opacity: reached ? 1 : 0.4,
                  }}
                />
              </div>
              <motion.div
                animate={{ opacity: reached ? 1 : 0.45 }}
                className="min-w-0 flex-1 pb-1"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-ink">{stage.title}</span>
                  <span
                    className="rounded-full px-1.5 py-px font-mono text-[8px] uppercase tracking-wider"
                    style={{ color: st.dot, backgroundColor: `${st.dot}1a` }}
                  >
                    {st.label}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-ink-muted">{stage.description}</p>
                <AnimatePresence>
                  {stage.detail && (isActive || !playing) && (
                    <motion.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-1 rounded border border-charcoal-700/50 bg-charcoal-850/70 px-2 py-1 font-mono text-[10px] text-teal-200/90"
                    >
                      {stage.detail}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
