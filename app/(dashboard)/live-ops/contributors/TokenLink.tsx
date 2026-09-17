"use client";

import { useState } from "react";

// Shows a contributor's public /host/<token> link and copies the ABSOLUTE URL
// (origin + path) to the clipboard. Origin is read at click time from the
// browser, so the copied link is correct in every environment without threading
// a base URL through the server.
export function TokenLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const path = `/host/${token}`;

  async function copy() {
    try {
      const url = `${window.location.origin}${path}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the visible path is still selectable */
    }
  }

  return (
    <div className="flex items-center gap-2">
      <a
        href={path}
        target="_blank"
        rel="noreferrer"
        className="max-w-[14rem] truncate font-mono text-[11px] text-teal-300 hover:underline"
        title={path}
      >
        {path}
      </a>
      <button
        type="button"
        onClick={copy}
        className="rounded-md bg-charcoal-800 px-2 py-1 text-[10px] font-semibold text-ink-muted hover:bg-charcoal-700 hover:text-ink"
      >
        {copied ? "Copied ✓" : "Copy link"}
      </button>
    </div>
  );
}
