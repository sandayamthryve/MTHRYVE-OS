import type { ReactNode } from "react";

// Pill / status chip matching the Command Center badges. Tone maps to the four
// accent roles plus a neutral: teal (good/live), amber (warn), red (risk),
// violet (info) and muted (neutral). Mono, uppercase, tracked micro-text.
type ColorTone = "teal" | "amber" | "red" | "violet" | "muted";
export type BadgeTone = ColorTone | "success" | "warning" | "destructive" | "info";

const TONE: Record<ColorTone, string> = {
  teal: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  red: "border-red-500/40 bg-red-500/10 text-red-300",
  violet: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  muted: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
};

// Support semantic status names used throughout dashboard pages.
const STATUS_TONE: Record<"success" | "warning" | "destructive" | "info", ColorTone> = {
  success: "teal",
  warning: "amber",
  destructive: "red",
  info: "violet",
};

function colorTone(tone: BadgeTone): ColorTone {
  return tone === "success" || tone === "warning" || tone === "destructive" || tone === "info"
    ? STATUS_TONE[tone]
    : tone;
}

export function Badge({
  children,
  tone = "muted",
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${TONE[colorTone(tone)]} ${className}`}
    >
      {children}
    </span>
  );
}
