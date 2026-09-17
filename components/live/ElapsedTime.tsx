"use client";

import { useEffect, useState } from "react";

// ElapsedTime — the ticking "live for HH:MM:SS" counter for a session that is
// LIVE right now. It counts up from the session's real started_at (passed as an
// ISO string) using the client clock; the number it shows is elapsed wall-time,
// nothing fabricated. Seeded from a server-computed `seedSeconds` so the first
// client paint matches SSR (no hydration flash), then it advances real time.
//
// This is the ONLY animated figure in the Live module — every GMV/CTR/units
// number is static server-rendered text. Under prefers-reduced-motion the value
// still ticks (it's time, not decoration); only the pulse dot is neutralised by
// the global reduced-motion rule.

function fmt(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export function ElapsedTime({
  startedAt,
  seedSeconds,
  className = "",
}: {
  startedAt: string;
  seedSeconds: number;
  className?: string;
}) {
  const [seconds, setSeconds] = useState(seedSeconds);

  useEffect(() => {
    const started = new Date(startedAt).getTime();
    if (!Number.isFinite(started)) return;
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span className={`font-mono tabular-nums ${className}`} suppressHydrationWarning aria-live="off">
      {fmt(seconds)}
    </span>
  );
}
