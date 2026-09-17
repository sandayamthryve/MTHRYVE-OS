"use client";

// AiBriefsProvider — coordinates the per-metric "✦ AI Brief" toggles so a single
// "Expand all AI Briefs" control in the header can open or close every brief on
// the Mission Control page at once, while each toggle still opens/closes on its
// own afterwards. The provider holds only UI state (no data); the brief content
// itself is server-rendered and passed to each toggle as props.

import { createContext, useCallback, useContext, useState } from "react";

// A "pulse" is a broadcast command: set every registered toggle to `open`. The
// monotonic `seq` lets each toggle react to a fresh command even when `open`
// repeats (expand-all → collapse-all → expand-all).
type Pulse = { open: boolean; seq: number };

interface BriefsCtx {
  pulse: Pulse | null;
  allOpen: boolean;
  setAll: (open: boolean) => void;
}

const Ctx = createContext<BriefsCtx | null>(null);

export function useAiBriefs(): BriefsCtx | null {
  return useContext(Ctx);
}

export function AiBriefsProvider({ children }: { children: React.ReactNode }) {
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [allOpen, setAllOpen] = useState(false);

  const setAll = useCallback((open: boolean) => {
    setAllOpen(open);
    setPulse((p) => ({ open, seq: (p?.seq ?? 0) + 1 }));
  }, []);

  return <Ctx.Provider value={{ pulse, allOpen, setAll }}>{children}</Ctx.Provider>;
}

export function ExpandAllBriefsButton() {
  const ctx = useAiBriefs();
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={() => ctx.setAll(!ctx.allOpen)}
      aria-pressed={ctx.allOpen}
      className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-violet-300 transition-colors hover:bg-violet-500/20"
    >
      <span aria-hidden>✦</span>
      {ctx.allOpen ? "Collapse all AI Briefs" : "Expand all AI Briefs"}
    </button>
  );
}
