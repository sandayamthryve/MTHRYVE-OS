"use client";

// Sourcing → CSV bulk import. Paste rows or pick a file; the server parses,
// dedups every row by email (matching creators are LINKED, not re-minted), links
// each to the campaign, and returns a per-outcome summary. Everything surfaces
// inline via useFormState — no navigation, no thrown errors.

import { useFormState, useFormStatus } from "react-dom";
import type { ImportSourcingState } from "@/app/(dashboard)/affiliate/actions";

const fieldCls =
  "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-3 rounded-md border border-charcoal-700 bg-charcoal-850 px-4 py-2 text-sm font-semibold text-ink hover:bg-charcoal-800 disabled:opacity-60"
    >
      {pending ? "Importing…" : "Import & link"}
    </button>
  );
}

export function ImportSourcingControl({
  action,
  campaignId,
}: {
  action: (prev: ImportSourcingState, formData: FormData) => Promise<ImportSourcingState>;
  campaignId: string;
}) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form
      action={formAction}
      className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate"
    >
      <input type="hidden" name="campaign_id" defaultValue={campaignId} />
      <h3 className="mb-1 text-sm font-semibold text-ink">Bulk import (CSV)</h3>
      <p className="mb-3 text-[11px] text-ink-dim">
        Header row required. Columns: <span className="font-mono">name, email, phone, platform,
        handle, category, followers</span>. Duplicate emails link the existing creator.
      </p>
      <textarea
        name="csv_text"
        rows={4}
        placeholder={"name,email,followers\nJuan Dela Cruz,juan@example.com,25000"}
        className={`${fieldCls} font-mono text-xs`}
      />
      <div className="mt-2">
        <input
          type="file"
          name="csv_file"
          accept=".csv,text/csv,text/plain"
          className="w-full max-w-full text-xs text-ink-muted file:mr-3 file:rounded-md file:border file:border-charcoal-700 file:bg-charcoal-850 file:px-3 file:py-1.5 file:text-xs file:text-ink"
        />
      </div>
      {state?.error && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
          {state.error}
        </p>
      )}
      {state?.summary && (
        <div className="mt-3 rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5 text-xs text-teal-100">
          <p className="font-semibold text-teal-200">Import complete</p>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
            <li>New creators added: {state.summary.added}</li>
            <li>Existing creators linked: {state.summary.linkedExisting}</li>
            <li>Already on this campaign: {state.summary.alreadyOnCampaign}</li>
            <li>Skipped: {state.summary.skipped}</li>
          </ul>
          {state.notes && state.notes.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-ink-muted">
                {state.notes.length} note{state.notes.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-1 space-y-0.5 text-[11px] text-ink-dim">
                {state.notes.map((n, i) => (
                  <li key={i}>• {n}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <SubmitButton />
    </form>
  );
}
