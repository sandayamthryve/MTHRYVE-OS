"use client";

// Import island for return cases. Takes a pasted CSV or an uploaded .csv file
// and hands it to the importReturnCases server action (passed down as a prop so
// the action itself can stay co-located in the warehouse page). The returned
// summary is surfaced inline via useFormState. Mirrors the metrics import island.

import { useFormState, useFormStatus } from "react-dom";

export type ImportReturnsState = { imported: number; skipped: string[] } | null;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Importing…" : "Import Returns (CSV)"}
    </button>
  );
}

export function ImportReturnsControl({
  action,
}: {
  action: (prev: ImportReturnsState, formData: FormData) => Promise<ImportReturnsState>;
}) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form action={formAction} className="space-y-3">
      <textarea
        name="csv"
        rows={4}
        placeholder="Paste CSV here, or choose a .csv file below…"
        className="block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 font-mono text-xs text-ink"
      />
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          className="w-full max-w-full text-xs text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-charcoal-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal-300 hover:file:bg-charcoal-700"
        />
        <SubmitButton />
      </div>
      <p className="text-xs text-ink-muted">
        columns: order_ref, brand, platform, product_name, sku, units, value, reason, fault, status,
        reported_date (YYYY-MM-DD), note
      </p>
      <p className="text-[11px] text-ink-dim">
        reason: wrong_missing_shortship · damaged_transit · defective_quality · rts_undelivered ·
        change_of_mind · other &nbsp;|&nbsp; fault: warehouse · courier · customer · listing ·
        supplier · unknown &nbsp;|&nbsp; status: open · received · refunded · restocked · disputed ·
        closed
      </p>
      {state && (
        <p className="text-sm text-ink">
          {state.imported} rows imported
          {state.skipped.length > 0
            ? `, ${state.skipped.length} skipped: ${state.skipped.join(" / ")}`
            : ""}
        </p>
      )}
    </form>
  );
}
