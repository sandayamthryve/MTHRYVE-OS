"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanQuality, type QualityScanResult } from "@/app/(dashboard)/warehouse/intelligence/scan-quality";

// The "Scan quality" signal producer on the Product Intelligence page. One click
// runs the shared quality engine over every brand and SKU for the trailing week
// and drafts one action per flagged brand/SKU into the approval queue for a human
// to approve. Nothing is paused, edited or contacted — Tony drafts, a human
// approves, the OS opens an internal quality task.
export function ScanQualityButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<QualityScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await scanQuality();
        setResult(res);
        router.refresh();
      } catch {
        setError("Scan failed. Please try again.");
      }
    });
  }

  const flagged = result ? result.flaggedBrands + result.flaggedProducts : 0;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-sm font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-60"
      >
        {pending ? "Scanning…" : "Scan quality"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[22rem] text-right text-xs text-ink-muted">
          {result.created > 0 ? (
            <>
              Drafted{" "}
              <span className="text-amber-200">
                {result.created} action{result.created === 1 ? "" : "s"}
              </span>{" "}
              to the{" "}
              <a href="/approvals" className="underline hover:text-ink">
                approval queue
              </a>{" "}
              ({result.flaggedBrands} brand · {result.flaggedProducts} SKU flagged)
              {result.skipped > 0 ? ` · ${result.skipped} already open` : ""}.
            </>
          ) : flagged > 0 ? (
            <>
              All {flagged} flagged {flagged === 1 ? "item" : "items"} already have an open request.
            </>
          ) : (
            <>
              Scanned {result.brandsScanned} brand{result.brandsScanned === 1 ? "" : "s"} ·{" "}
              {result.productsScanned} SKU{result.productsScanned === 1 ? "" : "s"} — nothing over the
              quality bar. Nothing to draft.
            </>
          )}
        </p>
      )}
    </div>
  );
}
