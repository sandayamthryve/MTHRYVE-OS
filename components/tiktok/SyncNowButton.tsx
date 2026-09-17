"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Leadership "Sync now" control for the TikTok Shop daily read-sync. POSTs to the
// sync route (which auth-checks the session), shows a pending state, then
// refreshes the page so the "Last synced" line and any new data update. The
// route never returns tokens or PII — only the { shops, endpoints, upserted,
// errors } summary, which we surface briefly inline.
export function SyncNowButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const busy = running || isPending;

  async function runSync() {
    setRunning(true);
    setNote(null);
    try {
      const res = await fetch("/api/integrations/tiktok/sync", { method: "POST" });
      const json = (await res.json().catch(() => null)) as {
        shops?: number;
        upserted?: number;
        errors?: string[];
        error?: string;
      } | null;
      if (!res.ok) {
        setNote(`Sync failed: ${json?.error ?? res.status}`);
      } else {
        const errs = json?.errors?.length ?? 0;
        setNote(
          `Synced ${json?.shops ?? 0} shop(s), ${json?.upserted ?? 0} rows` +
            (errs ? ` — ${errs} step error(s)` : " ✓")
        );
      }
    } catch {
      setNote("Sync failed: network error");
    } finally {
      setRunning(false);
      // Pull fresh server-rendered "Last synced" + status.
      startTransition(() => router.refresh());
    }
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={runSync}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-xs font-medium text-gold-300 hover:bg-gold-500/20 disabled:opacity-60"
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
      {note && <span className="text-[11px] text-ink-muted">{note}</span>}
    </span>
  );
}
