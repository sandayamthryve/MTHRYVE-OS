"use client";

// Copy-to-clipboard for a draft on a copy-only channel (Viber / WhatsApp /
// TikTok DM). These channels can NEVER be marked sent from the app — the
// operator copies the body and sends it by hand in that app, so we never fake a
// send. This button is the whole "send" affordance for those channels.

import { useState } from "react";

export function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API unavailable (insecure context / denied) — fall back to a
      // hidden textarea + execCommand so the operator still gets the text.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently — the body is still visible on the card */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-xs font-medium text-ink hover:bg-charcoal-800"
    >
      {copied ? "Copied ✓" : "Copy message"}
    </button>
  );
}
