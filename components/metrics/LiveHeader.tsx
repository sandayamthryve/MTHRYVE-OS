"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// LiveHeader — the "live layer" strip that sits beside the GMV figure on the
// Command Center and Brand Portfolio.
//
//   • A real Asia/Manila clock, ticking every second (date + HH:MM:SS).
//   • The "Data as of <Manila>" freshness stamp (server-computed, passed in).
//   • Active-window period progress + a labeled pace projection (server-computed).
//   • A silent auto-refresh: every ~60s it calls router.refresh() so the server
//     data re-reads. ONLY the clock animates — GMV and every other figure are
//     server-rendered and never incremented/animated on the client.
//
// The clock is seeded from the server's `nowIso` so the first client paint
// matches SSR (no hydration mismatch); the interval then advances real time.

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

export interface LiveHeaderProps {
  nowIso: string;
  freshness: string | null; // e.g. "Jul 11, 6:30 PM" or null for no data
  freshnessSource: "sync" | "metrics" | null;
  progress: string | null; // e.g. "MTD · Day 11 of 31 · 34% elapsed"
  pace: string | null; // e.g. "Pace → ₱4.2M projected month-end"
  refreshMs?: number; // default 60000
}

export function LiveHeader({
  nowIso,
  freshness,
  freshnessSource,
  progress,
  pace,
  refreshMs = 60000,
}: LiveHeaderProps) {
  const router = useRouter();
  const [now, setNow] = useState<Date>(() => new Date(nowIso));

  // Tick the clock every second.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Silent data refresh — re-runs the server component, no animation.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), refreshMs);
    return () => clearInterval(id);
  }, [router, refreshMs]);

  const freshnessLabel =
    freshnessSource === "sync" ? "Data as of" : freshnessSource === "metrics" ? "Data updated" : "Data";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-charcoal-700/60 bg-charcoal-950/50 p-3 text-right">
      {/* Live Manila clock */}
      <div className="flex items-center justify-end gap-2">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-teal-400" />
        <span className="font-mono text-xs text-ink-muted">{DATE_FMT.format(now)}</span>
        <span
          className="font-mono text-sm tabular-nums text-ink"
          suppressHydrationWarning
          aria-live="off"
        >
          {TIME_FMT.format(now)}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">PHT</span>
      </div>

      {/* Freshness stamp */}
      <p className="font-mono text-[10px] text-ink-dim">
        {freshness ? (
          <>
            {freshnessLabel} <span className="text-ink-muted">{freshness}</span> · Manila
          </>
        ) : (
          <span className="text-ink-muted">No data yet — nothing synced or imported</span>
        )}
      </p>

      {/* Period progress + pace */}
      {progress && (
        <p className="font-mono text-[10px] text-ink-dim">
          <span className="text-ink-muted">{progress}</span>
          {pace ? <span className="ml-1 text-teal-300">· {pace}</span> : null}
        </p>
      )}
    </div>
  );
}
