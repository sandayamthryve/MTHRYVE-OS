"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { analyzeLiveSession, type LiveCoachResult } from "@/app/(dashboard)/live-wall/analyze";

// Tony Live-Coach trigger on a live tile. One click runs the Cognition Loop over
// the Live compartment and files a 3-possibility bottleneck brief into the
// approval queue (source_module='live_coach'). Nothing auto-executes — Tony
// drafts, a human approves. Purely a UX shell over the server action; the result
// line stays honest about thin data and failures.
export function AnalyzeButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<LiveCoachResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const res = await analyzeLiveSession(sessionId);
        setResult(res);
        if (res.ok && res.created > 0) router.refresh();
      } catch {
        setError("Analysis failed. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="inline-flex items-center justify-center gap-1.5 rounded-md bg-violet-500/90 px-2.5 py-1.5 text-[11px] font-semibold text-charcoal-950 hover:bg-violet-400 disabled:opacity-60"
      >
        {pending ? "Analyzing…" : "✨ Analyze (Tony)"}
      </button>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {result && (
        <p className="text-[11px] text-ink-muted">
          {!result.ok ? (
            <span className="text-red-400">{result.error ?? "Something went wrong."}</span>
          ) : result.thin ? (
            <>No Live-compartment metric has an entry yet — nothing to reason over.</>
          ) : result.created > 0 ? (
            <>
              Brief filed to the{" "}
              <a href="/approvals" className="underline hover:text-ink">approval queue</a>{" "}
              ({result.grounded}/{result.total} grounded). Nothing runs on its own.
            </>
          ) : (
            <>Nothing drafted.</>
          )}
        </p>
      )}
    </div>
  );
}
