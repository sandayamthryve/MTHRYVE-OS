"use client";

import { useFormState, useFormStatus } from "react-dom";
import { useState } from "react";

export type ImportMetricsState =
  | {
      status: "success" | "invalid" | "failure";
      imported: number;
      skipped: string[];
      message?: string;
    }
  | null;

function SubmitButton({ hasInput }: { hasInput: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || !hasInput}
      className="rounded-lg bg-teal-500 px-4 py-2 text-xs font-semibold text-charcoal-950 transition hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {pending ? "Importing…" : "Import Metrics"}
    </button>
  );
}

export function ImportMetricsControl({
  action,
}: {
  action: (prev: ImportMetricsState, formData: FormData) => Promise<ImportMetricsState>;
}) {
  const [state, formAction] = useFormState(action, null);
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const hasInput = Boolean(fileName || csv.trim());

  return (
    <form action={formAction} className="space-y-4">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
        Imports are additive. Existing metric records are never silently overwritten; every valid row is inserted as a new time-series record.
      </div>

      <label className="block rounded-xl border border-dashed border-charcoal-700 bg-charcoal-950/70 p-4 text-center transition hover:border-charcoal-600">
        <span className="block text-xs font-semibold text-ink">Select CSV file</span>
        <span className="mt-1 block text-[10px] text-ink-dim">.csv · metric snapshot columns</span>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
          className="sr-only"
        />
        <span className="mt-3 inline-flex rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-[11px] font-medium text-teal-300">
          {fileName || "Choose file"}
        </span>
      </label>

      <div className="flex items-center gap-3"><div className="h-px flex-1 bg-charcoal-700/60" /><span className="text-[9px] uppercase tracking-[0.16em] text-ink-dim">or paste CSV</span><div className="h-px flex-1 bg-charcoal-700/60" /></div>

      <textarea
        name="csv"
        value={csv}
        onChange={(event) => setCsv(event.target.value)}
        rows={4}
        placeholder="department,period_start,period_end,efficiency,quality_score,capacity_utilization,gmv_impact"
        className="block w-full resize-none rounded-xl border border-charcoal-700 bg-charcoal-950 p-3 font-mono text-[10px] leading-relaxed text-ink outline-none focus:border-teal-500/60"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-sm text-[10px] leading-relaxed text-ink-dim">Supported columns: department, period_start, period_end, efficiency, quality_score, capacity_utilization, gmv_impact.</p>
        <SubmitButton hasInput={hasInput} />
      </div>

      {state && (
        <div
          role="status"
          className={`rounded-xl border px-3 py-2.5 text-xs ${
            state.status === "success"
              ? "border-teal-500/25 bg-teal-500/[0.05] text-teal-200"
              : state.status === "invalid"
                ? "border-amber-500/25 bg-amber-500/[0.05] text-amber-200"
                : "border-red-500/25 bg-red-500/[0.05] text-red-200"
          }`}
        >
          <p className="font-semibold">
            {state.status === "success" ? "Import complete" : state.status === "invalid" ? "Some data could not be imported" : "Import failed"}
          </p>
          <p className="mt-1 text-[11px] opacity-85">{state.message || `${state.imported} row${state.imported === 1 ? "" : "s"} imported.`}</p>
          {state.skipped.length > 0 && (
            <div className="mt-2 max-h-24 overflow-y-auto rounded-lg bg-black/15 p-2 font-mono text-[10px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {state.skipped.map((item, index) => <p key={index}>{item}</p>)}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
