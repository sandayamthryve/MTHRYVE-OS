"use client";

// Import island for leads. Takes a pasted CSV or an uploaded .csv / .xlsx file and
// hands it to the importLeads server action (passed down as a prop so the action
// itself can stay co-located in the leads page). Both formats go through the ONE
// shared server-side parser (lib/snapfill/import) with the same header→field-
// whitelist mapping and honest nulls. The returned summary is surfaced inline via
// useFormState.

import { useFormState, useFormStatus } from "react-dom";

export type ImportLeadsState = { imported: number; skipped: string[] } | null;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Importing…" : "Import Leads (CSV / XLSX)"}
    </button>
  );
}

export function ImportLeadsControl({
  action,
}: {
  action: (prev: ImportLeadsState, formData: FormData) => Promise<ImportLeadsState>;
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
          accept=".csv,text/csv,.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="w-full max-w-full text-xs text-ink-muted file:mr-3 file:rounded-md file:border-0 file:bg-charcoal-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal-300 hover:file:bg-charcoal-700"
        />
        <SubmitButton />
      </div>
      <p className="text-xs text-ink-muted">
        .csv or .xlsx — header row maps to: name, company, email, phone, source, department, stage, value, notes
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
