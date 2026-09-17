"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runCognitionLoop, type CognitionRunResult } from "@/app/(dashboard)/tony/run-cognition-loop";

// The "Run Cognition Loop" trigger on the Tony page. One click reads the chosen
// compartment scope (default T8 Shop Health + T9 store-rating pillars) against
// its targets, has Tony emit a 3-possibility brief, and files it into the
// approval queue as a pending action_request. Nothing auto-executes — Tony
// drafts, a human approves. Purely a UX shell over the server action.
export function RunCognitionLoopButton({ compartmentCodes }: { compartmentCodes?: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CognitionRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await runCognitionLoop(compartmentCodes);
        setResult(res);
        if (res.ok && res.created > 0) router.refresh();
      } catch {
        setError("Run failed. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
      >
        {pending ? "Reading & reasoning…" : "Run Cognition Loop"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {result && (
        <p className="max-w-[30rem] text-xs text-ink-muted">
          {!result.ok ? (
            <span className="text-red-400">{result.error ?? "Something went wrong."}</span>
          ) : result.thin ? (
            <>
              No metric in {result.scopeLabel} has an entry yet — nothing to reason over. Enter the
              shop-health numbers first, then run the loop.
            </>
          ) : result.created > 0 ? (
            <>
              Brief filed to the{" "}
              <a href="/approvals" className="underline hover:text-ink">
                approval queue
              </a>{" "}
              — grounded on {result.grounded}/{result.total} real metrics. Review the 3 options and
              Approve or Hold. Nothing runs on its own.
            </>
          ) : (
            <>Nothing drafted.</>
          )}
        </p>
      )}
    </div>
  );
}
