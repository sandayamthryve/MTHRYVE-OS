"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Keeps the mission-control grid live. Every `intervalMs` it calls
// router.refresh(), which re-runs the server component and pulls fresh session
// rows + Live-compartment metrics without a full navigation. A checkbox lets a
// viewer pause the auto-refresh (e.g. while editing a tile). Purely additive —
// the page is fully usable with JS off; this only keeps it current.
export function LiveAutoRefresh({ intervalMs = 20000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  const savedOn = useRef(on);
  savedOn.current = on;

  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      // Only refresh when the tab is visible — no point churning in the background.
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        router.refresh();
      }
    }, Math.max(5000, intervalMs));
    return () => clearInterval(t);
  }, [on, intervalMs, router]);

  return (
    <label className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
      <span className={`relative flex h-2 w-2 ${on ? "" : "opacity-40"}`}>
        {on && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-500/70" />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${on ? "bg-teal-400" : "bg-ink-dim"}`} />
      </span>
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="accent-teal-500" />
      Live updates
    </label>
  );
}
