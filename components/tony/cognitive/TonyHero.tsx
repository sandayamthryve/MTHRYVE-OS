"use client";

// components/tony/cognitive/TonyHero.tsx — the tab shell that makes the TCVE the
// hero of the Tony landing while KEEPING the existing Command View constellation
// (and everything below it) one click away. The sidebar navigation is untouched;
// this is purely an in-page view switch. The Command View subtree is server-
// rendered and passed in as `commandView` so this thin client component just
// toggles which view is shown.

import { useState } from "react";
import { motion } from "framer-motion";
import type { TcveGraph } from "@/lib/tony/graph-types";
import { CognitiveEngine } from "./CognitiveEngine";

type View = "cognitive" | "command";

export function TonyHero({
  graph,
  commandView,
}: {
  graph: TcveGraph;
  commandView: React.ReactNode;
}) {
  const [view, setView] = useState<View>("cognitive");

  const tabs: Array<{ key: View; label: string; hint: string }> = [
    { key: "cognitive", label: "Cognitive Engine", hint: "the living graph — for seeing" },
    { key: "command", label: "Command View", hint: "the metric constellation — for doing" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="inline-flex w-fit items-center gap-1 rounded-lg border border-charcoal-700/60 bg-charcoal-900/60 p-1">
        {tabs.map((t) => {
          const activeTab = view === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setView(t.key)}
              title={t.hint}
              className={`relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                activeTab ? "text-charcoal-950" : "text-ink-muted hover:text-ink"
              }`}
            >
              {activeTab && (
                <motion.span
                  layoutId="tony-hero-tab"
                  className="absolute inset-0 rounded-md bg-gradient-to-b from-teal-300 to-teal-500 shadow-glow"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                />
              )}
              <span className="relative">{t.label}</span>
            </button>
          );
        })}
      </div>

      {view === "cognitive" ? <CognitiveEngine initialGraph={graph} /> : <div>{commandView}</div>}
    </div>
  );
}
