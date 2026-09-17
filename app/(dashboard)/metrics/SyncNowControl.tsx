"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// "Sync now" (Phase 2, Part A — optional leadership control). Runs the API
// Validation Overlay sync for a chosen period against the caller's own org. It
// POSTs to /api/metrics/sync with the session cookie — NO secret in the client;
// the route authorizes the leadership session server-side and the service-role
// key never leaves the server.

export function SyncNowControl({ defaultStart, defaultEnd }: { defaultStart: string; defaultEnd: string }) {
  const router = useRouter();
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/metrics/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ period_start: start, period_end: end }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        results?: Array<{ applied: unknown[]; escalated: unknown[] }>;
      };
      if (!res.ok) {
        setMsg(body.error ? `Error: ${body.error}` : `Error (${res.status})`);
      } else {
        const applied = (body.results ?? []).reduce((n, r) => n + (r.applied?.length ?? 0), 0);
        const escalated = (body.results ?? []).reduce((n, r) => n + (r.escalated?.length ?? 0), 0);
        setMsg(`Synced — ${applied} API value${applied === 1 ? "" : "s"} written${escalated ? `, ${escalated} escalated` : ""}.`);
        router.refresh();
      }
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-[10px] text-ink-muted">
        From
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="mt-1 block rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
        />
      </label>
      <label className="text-[10px] text-ink-muted">
        To
        <input
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="mt-1 block rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
        />
      </label>
      <button
        type="button"
        onClick={run}
        disabled={busy || !start || !end}
        className="rounded-md bg-teal-500 px-3 py-2 text-xs font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-50"
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
      {msg && <span className="text-[11px] text-ink-muted">{msg}</span>}
    </div>
  );
}
