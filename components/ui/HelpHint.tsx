"use client";

import { useEffect, useId, useRef, useState } from "react";
import { getHelp } from "@/lib/help/registry";

// A small "(?)" help affordance that sits inline next to a cluster or section
// title. On hover, keyboard focus, or tap it reveals a short plain-language
// explainer sourced from lib/help/registry.ts — so any user understands what
// they're looking at without training.
//
// Purely additive and dependency-free: no external tooltip library, just the
// shared design tokens. Accessible by construction — it's a real <button>
// (keyboard-focusable, Enter/Space to toggle), carries an aria-label, links the
// popover with aria-describedby + role="tooltip", opens on focus for keyboard
// users, and closes on Escape or an outside tap for touch users. The visible
// glyph stays small while an invisible ::before extends the tap target well past
// the 44px comfort zone on mobile.
//
// If the id isn't in the registry it renders nothing — a missing hint never
// breaks a header.
export function HelpHint({ id, className = "" }: { id: string; className?: string }) {
  const entry = getHelp(id);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  // While open, close on Escape or on any interaction outside the widget — the
  // latter is what makes tap-to-open dismissable on touch devices (which have no
  // mouseleave). Listeners are only attached while open, so there's no idle cost.
  useEffect(() => {
    if (!open) return;
    const onOutside = (e: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!entry) return null;

  return (
    <span
      ref={wrapRef}
      className={`relative inline-flex align-middle ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`What is ${entry.title}?`}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="relative inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-charcoal-700 bg-charcoal-800 text-[11px] font-semibold leading-none text-ink-dim transition-colors before:absolute before:-inset-2 before:content-[''] hover:border-teal-500/50 hover:text-teal-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/60"
      >
        ?
      </button>
      {open ? (
        <span
          role="tooltip"
          id={tipId}
          className="absolute left-0 top-full z-50 mt-2 block w-64 max-w-[min(18rem,80vw)] cursor-default rounded-md border border-charcoal-700 bg-charcoal-800 p-3 text-left font-body shadow-elevate"
        >
          <span className="block text-xs font-semibold text-ink">{entry.title}</span>
          <span className="mt-1 block text-xs font-normal leading-relaxed text-ink-muted">
            {entry.body}
          </span>
        </span>
      ) : null}
    </span>
  );
}
