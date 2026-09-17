"use client";

import { useState } from "react";

// A small copy-to-clipboard button for Vesper's copy-paste channels (Viber / DM),
// where the OS never sends and the human sends the message by hand. Purely
// client-side — it copies the given text and confirms briefly. Falls back to
// selecting nothing loud when the Clipboard API is unavailable (older/insecure
// contexts) by surfacing a short "copy failed" hint instead of pretending.
export function CopyButton({
  text,
  label = "Copy message",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("no clipboard");
      }
      setState("copied");
      setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("failed");
      setTimeout(() => setState("idle"), 2400);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={
        "rounded-md border border-charcoal-700 px-2.5 py-1.5 text-xs font-medium text-ink-muted hover:bg-charcoal-800 hover:text-ink " +
        className
      }
    >
      {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed — select & copy" : label}
    </button>
  );
}
