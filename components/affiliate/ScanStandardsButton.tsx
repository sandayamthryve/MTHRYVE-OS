"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanStandards, type StandardsScanResult } from "@/app/(dashboard)/creators/scan-standards";

// The "Scan standards" signal producer on the Creators/Affiliate page. Built for
// the Monday review (also runnable for the daily huddle): one click grades every
// creator with an active deal + weekly commitment against their tier's standard,
// over the LAST COMPLETED ISO week, and drafts one action per below-standard
// creator into the approval queue for a human to approve. Nothing is paused or
// sent — Tony drafts, a human approves, the OS opens the task.
export function ScanStandardsButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<StandardsScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await scanStandards();
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
        {pending ? "Scanning…" : "Scan standards"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[18rem] text-right text-xs text-ink-muted">
          {result.created > 0 ? (
            <>
              Drafted{" "}
              <span className="text-teal-300">
                {result.created} action{result.created === 1 ? "" : "s"}
              </span>{" "}
              to the{" "}
              <a href="/approvals" className="underline hover:text-ink">
                approval queue
              </a>
              {result.skipped > 0 ? ` · ${result.skipped} already open` : ""}. Week {result.isoWeek}.
            </>
          ) : result.belowStandard > 0 ? (
            <>
              All {result.belowStandard} below-standard creator
              {result.belowStandard === 1 ? "" : "s"} already have an open request for {result.isoWeek}.
            </>
          ) : (
            <>
              Scanned {result.scanned} creator{result.scanned === 1 ? "" : "s"} for {result.weekLabel} —
              all meeting standard. Nothing to draft.
            </>
          )}
        </p>
      )}
    </div>
  );
}
