"use client";

import { useState } from "react";

// The TikTok order id, shown prominently in mono and copyable in one click —
// this is the value TikTok App Review inspects, so it leads the row and is easy
// to lift out. Purely client-side: copies the id and confirms briefly, and
// surfaces an honest "copy failed" (never a silent success) when the Clipboard
// API is unavailable (older/insecure contexts).
export function OrderId({ orderId }: { orderId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(orderId);
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
    <span className="inline-flex items-center gap-2">
      <span className="select-all font-mono text-sm font-semibold tracking-tight text-ink">
        {orderId}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy order ID ${orderId}`}
        title="Copy order ID"
        className="rounded-md border border-charcoal-700 px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-charcoal-800 hover:text-ink"
      >
        {state === "copied" ? "Copied ✓" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
    </span>
  );
}
