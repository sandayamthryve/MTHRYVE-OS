"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { scanFollowUps, type FollowUpScanResult } from "@/app/(dashboard)/outreach/scan-follow-ups";

// The "Scan follow-ups" signal producer, shared by the BizDev and Creators pages.
// One click scans BOTH sources (client leads + affiliate/KOL creators) server-side
// and reports honestly what it found — no drafts when nothing is genuinely due.
// New drafts land in the Action & Approval Queue for a human to approve; nothing
// is sent.
export function ScanFollowUpsButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<FollowUpScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await scanFollowUps();
        setResult(res);
        router.refresh();
      } catch {
        setError("Scan failed. Please try again.");
      }
    });
  }

  const due = result ? result.dueLeads + result.dueCreators : 0;
  const scanned = result ? result.scannedLeads + result.scannedCreators : 0;

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
      >
        {pending ? "Scanning…" : "Scan follow-ups"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[18rem] text-right text-xs text-ink-muted">
          {result.created > 0 ? (
            <>
              Drafted{" "}
              <span className="text-teal-300">
                {result.created} follow-up{result.created === 1 ? "" : "s"}
              </span>{" "}
              to the{" "}
              <a href="/approvals" className="underline hover:text-ink">
                approval queue
              </a>
              {result.skipped > 0 ? ` · ${result.skipped} already open` : ""}.
            </>
          ) : due > 0 ? (
            <>All {due} due follow-ups already have an open request.</>
          ) : (
            <>Scanned {scanned} contacts — none due. Nothing to draft.</>
          )}
        </p>
      )}
    </div>
  );
}
