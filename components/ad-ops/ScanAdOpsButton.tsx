"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanAdOps, type AdOpsScanResult } from "@/app/(dashboard)/ad-ops/scan-ad-ops";

// The "Scan ad performance" producer on the Ad Ops page. One click reads TikTok
// + Meta performance over the last 7 days via Windsor and drafts one gated
// action per winner/loser into the approval queue. Nothing is paused or scaled
// here — Vesper drafts, a human (ceo/coo) approves, the OS executes.
export function ScanAdOpsButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<AdOpsScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await scanAdOps();
        setResult(res);
        router.refresh();
      } catch {
        setError("Scan failed. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
      >
        {pending ? "Scanning…" : "Scan ad performance"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[20rem] text-right text-xs text-ink-muted">
          {!result.configured ? (
            <span className="text-amber-300">
              Ad connector not configured — nothing scanned. Set WINDSOR_API_KEY.
            </span>
          ) : result.created > 0 ? (
            <>
              Drafted{" "}
              <span className="text-teal-300">
                {result.created} action{result.created === 1 ? "" : "s"}
              </span>{" "}
              to the{" "}
              <a href="/approvals" className="underline hover:text-ink">
                approval queue
              </a>
              {result.skipped > 0 ? ` · ${result.skipped} already open` : ""}. {result.windowLabel}.
            </>
          ) : result.flagged > 0 ? (
            <>
              All {result.flagged} flagged campaign{result.flagged === 1 ? "" : "s"} already have an open
              request. {result.windowLabel}.
            </>
          ) : (
            <>
              Scanned {result.scanned} campaign{result.scanned === 1 ? "" : "s"} for {result.windowLabel} —
              none tripped a pause/scale rule. Nothing to draft.
            </>
          )}
          {result.errors.length > 0 && (
            <span className="mt-1 block text-red-400">
              {result.errors.map((e) => `${e.platform}: ${e.message}`).join(" · ")}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
