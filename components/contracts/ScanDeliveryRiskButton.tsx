"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanDeliveryRisk, type ScanResult } from "@/app/(dashboard)/contracts/actions";

// Leadership-triggered signal producer. Runs the delivery-risk scan server-side
// and reports honestly what it found — no drafts when nothing is genuinely at
// risk. New drafts land in the Action & Approval Queue for a human to approve.
export function ScanDeliveryRiskButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await scanDeliveryRisk();
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
        {pending ? "Scanning…" : "Scan delivery risk"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[16rem] text-right text-xs text-ink-muted">
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
              {result.skipped > 0 ? ` · ${result.skipped} already open` : ""}.
            </>
          ) : result.atRisk > 0 ? (
            <>All {result.atRisk} at-risk deliverables already have an open request.</>
          ) : (
            <>Scanned {result.scanned} deliverables — none at risk. Nothing to draft.</>
          )}
        </p>
      )}
    </div>
  );
}
