"use client";

// Bridge → IMPORT RESULTS. Upload (or paste) the Gmail-merge result CSV — two
// columns are enough: recipient email + the per-row status (Sent / Opened /
// Replied / Rejected / Bounced / Unsubscribed). Each row is matched by email to
// an exported message and its delivery_status is updated; a REPLY advances the
// contact's stage, a BOUNCE / OPT-OUT durably suppresses. This closes the loop.

import { useFormState, useFormStatus } from "react-dom";
import type { ImportState } from "@/lib/outreach/bridge-actions";
import type { RecipientType } from "@/lib/outreach/bridge";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Importing…" : "Import merge results"}
    </button>
  );
}

export function ImportResultsForm({
  action,
  recipientType,
}: {
  action: (prev: ImportState, formData: FormData) => Promise<ImportState>;
  recipientType: RecipientType;
}) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="recipient_type" value={recipientType} />
      <textarea
        name="csv"
        rows={3}
        placeholder="Paste result CSV (email,status), or choose a file below…"
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
      <p className="text-[11px] text-ink-dim">
        Columns: <span className="font-mono">email</span>, <span className="font-mono">status</span>. Status maps
        loosely — Sent, Opened, Replied, Rejected/Bounced, Unsubscribed/Opt-out.
      </p>
      {state?.error && <p className="text-sm text-red-300">{state.error}</p>}
      {state && !state.error && (
        <div className="text-sm text-ink">
          <p>
            {state.matched} matched · {state.updated} updated · {state.replied} replied · {state.suppressed} suppressed
          </p>
          {state.skipped.length > 0 && (
            <p className="mt-1 text-xs text-ink-muted">
              {state.skipped.length} skipped: {state.skipped.slice(0, 6).join(" / ")}
              {state.skipped.length > 6 ? " …" : ""}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
