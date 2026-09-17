"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanCashflow, type CashflowScanResult } from "@/app/(dashboard)/finance/scan-cashflow";

// The "Scan cash flow" signal producer on the Finance page. One click runs the
// shared forecast engine over the latest cash position and, if a deficit is
// projected inside the horizon, drafts one action into the approval queue for a
// human to approve. Nothing is transferred — Tony drafts, a human approves, the
// OS opens a CEO/COO planning task.
export function ScanCashflowButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CashflowScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await scanCashflow();
        setResult(res);
        router.refresh();
      } catch {
        setError("Scan failed. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
      >
        {pending ? "Scanning…" : "Scan cash flow"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[24rem] text-xs text-ink-muted">
          {!result.hasAnchor ? (
            <>No cash position set — set current cash on hand above to project runway.</>
          ) : result.created > 0 ? (
            <>
              Drafted{" "}
              <span className="text-teal-300">1 action</span> to the{" "}
              <a href="/approvals" className="underline hover:text-ink">
                approval queue
              </a>{" "}
              — deficit projected in {result.runwayDays} day
              {result.runwayDays === 1 ? "" : "s"}.
            </>
          ) : result.skipped ? (
            <>A cash-flow action was already drafted this week — nothing to add.</>
          ) : result.deficit ? (
            <>Deficit projected, but a draft already exists. Nothing to add.</>
          ) : (
            <>Forecast is cash-positive through the horizon — nothing to draft.</>
          )}
        </p>
      )}
    </div>
  );
}
