"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanWarehouse, type WarehouseScanResult } from "@/app/(dashboard)/warehouse/intelligence/scan-warehouse";

// The "Scan warehouse" signal producer on the Product Intelligence page. One
// click runs the shared velocity engine over every product, routes each to
// REPLENISH or PUSH-TO-SELL (never both), and drafts one action per at-risk
// product into the approval queue for a human to approve. Nothing is ordered,
// discounted or seeded — Tony drafts, a human approves, the OS opens the task.
export function ScanWarehouseButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<WarehouseScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await scanWarehouse();
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
        {pending ? "Scanning…" : "Scan warehouse"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[20rem] text-right text-xs text-ink-muted">
          {result.created > 0 ? (
            <>
              Drafted{" "}
              <span className="text-teal-300">
                {result.created} action{result.created === 1 ? "" : "s"}
              </span>{" "}
              to the{" "}
              <a href="/approvals" className="underline hover:text-ink">
                approval queue
              </a>{" "}
              ({result.replenish} replenish · {result.push} push)
              {result.skipped > 0 ? ` · ${result.skipped} already open` : ""}.
            </>
          ) : result.replenish + result.push > 0 ? (
            <>
              All {result.replenish + result.push} at-risk product
              {result.replenish + result.push === 1 ? "" : "s"} already have an open request.
            </>
          ) : (
            <>
              Scanned {result.scanned} product{result.scanned === 1 ? "" : "s"} — nothing at risk.
              Nothing to draft.
            </>
          )}
        </p>
      )}
    </div>
  );
}
