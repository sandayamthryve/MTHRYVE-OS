"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// The result the admin route echoes back after a manual run.
interface RunResult {
  ok: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  errors: string[];
  summary: string;
  ranAt?: string;
}

export interface AutomationJobView {
  key: string;
  name: string;
  description: string;
  // Pre-formatted "last successful run" label (Asia/Manila) or "never".
  lastRunLabel: string;
}

// Settings → Automation. One row per scheduled job, with the real last-run
// timestamp and a "Run now" button that fires the SAME work by the user's own
// session (leadership-only, enforced server-side). The button disables while a
// run is in flight — the server also rate-limits to one run per job per 60s, so
// a double-click can never start two concurrent syncs. On completion the row
// reports what the run actually did (created / updated / skipped / errors),
// never a bare "Success".
export function AutomationPanel({ jobs }: { jobs: AutomationJobView[] }) {
  return (
    <div className="flex flex-col divide-y divide-charcoal-700/60">
      {jobs.map((job) => (
        <JobRow key={job.key} job={job} />
      ))}
    </div>
  );
}

function JobRow({ job }: { job: AutomationJobView }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runNow() {
    if (running) return; // client-side guard on top of the server rate-limit
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: job.key }),
      });
      const json = (await res.json().catch(() => null)) as (RunResult & { error?: string; retryAfterSeconds?: number }) | null;
      if (!res.ok) {
        if (res.status === 429) {
          setError(
            `Already ran in the last minute — wait ${json?.retryAfterSeconds ?? 60}s before running again.`
          );
        } else if (res.status === 403) {
          setError("Forbidden — leadership only.");
        } else {
          setError(`Run failed: ${json?.error ?? res.status}`);
        }
      } else if (json) {
        setResult(json);
        // Pull the fresh server-rendered "last run" timestamp.
        router.refresh();
      }
    } catch {
      setError("Run failed: network error.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{job.name}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{job.description}</p>
        <p className="mt-1.5 text-[11px] text-ink-dim">
          Last successful run: <span className="text-ink-muted">{job.lastRunLabel}</span>
        </p>

        {/* Result — what the run actually did. Never a bare "Success". */}
        {result && (
          <div
            className={`mt-2 rounded-md border px-3 py-2 text-xs ${
              result.ok && result.errors.length === 0
                ? "border-green-500/30 bg-green-500/5 text-green-300"
                : result.ok
                  ? "border-gold-500/30 bg-gold-500/5 text-gold-300"
                  : "border-red-500/30 bg-red-500/5 text-red-300"
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {typeof result.created === "number" && (
                <span>
                  <span className="font-mono font-semibold">{result.created}</span> created
                </span>
              )}
              {typeof result.updated === "number" && (
                <span>
                  <span className="font-mono font-semibold">{result.updated}</span> updated
                </span>
              )}
              {typeof result.skipped === "number" && (
                <span>
                  <span className="font-mono font-semibold">{result.skipped}</span> skipped
                </span>
              )}
              <span>
                <span className="font-mono font-semibold">{result.errors.length}</span> error
                {result.errors.length === 1 ? "" : "s"}
              </span>
            </div>
            {result.summary && <p className="mt-1 text-ink-muted">{result.summary}</p>}
            {result.errors.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-red-300/90">
                {result.errors.slice(0, 5).map((e, i) => (
                  <li key={i} className="truncate">
                    {e}
                  </li>
                ))}
                {result.errors.length > 5 && <li>…and {result.errors.length - 5} more</li>}
              </ul>
            )}
          </div>
        )}

        {error && (
          <p className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}
      </div>

      <div className="shrink-0">
        <button
          type="button"
          onClick={runNow}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-xs font-medium text-gold-300 hover:bg-gold-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? "Running…" : "Run now"}
        </button>
      </div>
    </div>
  );
}
