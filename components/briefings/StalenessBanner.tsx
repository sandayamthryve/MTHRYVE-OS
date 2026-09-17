import type { ReactNode } from "react";
import { briefingStaleness } from "@/lib/briefings/exec-figures";

// PR 7/8 — the ONE staleness banner for every cached-narrative surface.
//
// A briefing narrative (org / account / department) is cached AI prose and may
// legitimately be hours or days old, but a stale narrative must never read as
// current fact. This banner is the unmissable signal: it renders ONLY once the
// narrative crosses 24h, states when it was generated and how old it is, and
// (optionally) offers a refresh control. Extracted so the Command Center,
// Accounts, and Department surfaces all show the identical treatment — one
// pattern, not three copies.

// Manila-local "Mon D, h:mm AM" for the generated-at stamp. Kept here so every
// surface labels the generation time identically.
export function whenLabel(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

function ageLabel(ageDays: number): string {
  return ageDays === 0 ? "over a day" : `${ageDays} day${ageDays === 1 ? "" : "s"}`;
}

// The amber staleness banner. Returns null when the source is fresh (within the
// threshold) or the timestamp is missing/invalid, so a caller can render it
// unconditionally. `noun` names what aged ("briefing", "action plan", "cash
// position", …); `refresh` is an optional control (a server-action <form>) shown
// on the right — omit it on read-only mounts. `staleAfterHours` overrides the
// default 24h threshold for surfaces with a longer freshness contract (Finance
// passes 7 * 24 for cash positions). `verb` labels the timestamp ("Generated" for
// a produced narrative, "As of" for a dated figure like a cash position).
export function StalenessBanner({
  createdAt,
  nowMs,
  noun = "briefing",
  refresh,
  staleAfterHours,
  verb = "Generated",
}: {
  createdAt: string | null | undefined;
  nowMs: number;
  noun?: string;
  refresh?: ReactNode;
  staleAfterHours?: number;
  verb?: string;
}) {
  const stale = briefingStaleness(createdAt, nowMs, staleAfterHours);
  if (!stale?.isStale || !createdAt) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
        <span aria-hidden className="text-base leading-none">
          ⚠
        </span>
        {verb} {whenLabel(createdAt)} · {ageLabel(stale.ageDays)} old
        <span className="font-normal text-amber-200/80">
          {" "}
          — this {noun} may be out of date.
        </span>
      </p>
      {refresh ? <div className="shrink-0">{refresh}</div> : null}
    </div>
  );
}
