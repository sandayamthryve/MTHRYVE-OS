"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { tapLink, TIER_LABEL, type TapTier } from "@/lib/daily-tap/types";
import { TapBriefLink } from "@/components/daily-tap/TapBriefLink";

// The in-app snooze nudge. Mounted once in the app shell (so it runs only AFTER
// LOGIN), it polls /api/daily-tap/nudge-check on load and every 20 minutes. The
// server owns all the rules — unacted, under the 3× cap, ≥ 20 min since the last
// nudge — and only returns nudge:true (advancing the counter) when the tap
// genuinely should re-show. This component just renders the toast when told to.
// IN-APP ONLY: it never re-sends the email. It disappears once the user acts
// (opening the brief marks the tap acted) or the cap is reached.

const POLL_MS = 20 * 60 * 1000; // 20 minutes — matches the server snooze interval

interface NudgePayload {
  tier: TapTier;
  summary: string | null;
  tap_date: string;
  ai_used: boolean;
}

export function TapNudge() {
  const [tap, setTap] = useState<NudgePayload | null>(null);
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (inFlight.current || typeof document === "undefined" || document.hidden) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/daily-tap/nudge-check", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { nudge?: boolean; tap?: NudgePayload };
      if (data.nudge && data.tap) setTap(data.tap);
    } catch {
      /* silent — a missed poll just means the next one tries again */
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void check();
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => window.clearInterval(id);
  }, [check]);

  if (!tap) return null;

  const link = tapLink(tap.tier);
  // A short preview — the first few non-empty lines of the tap body.
  const preview = (tap.summary ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("\n");

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 shadow-elevate"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-teal-400">
            ☀
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Daily Tap · {TIER_LABEL[tap.tier]}
          </span>
          {tap.ai_used && (
            <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-300">
              AI
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setTap(null)}
          aria-label="Dismiss for now"
          className="rounded-md p-1 text-ink-dim transition-colors hover:bg-charcoal-800 hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <p className="mb-3 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-muted">{preview}</p>

      <div className="flex items-center gap-2">
        <TapBriefLink href={link.href} label={link.label} tone="primary" onDone={() => setTap(null)} />
        <button
          type="button"
          onClick={() => setTap(null)}
          className="rounded-lg px-2 py-2 text-sm text-ink-dim transition-colors hover:text-ink-muted"
        >
          Later
        </button>
      </div>
    </div>
  );
}
