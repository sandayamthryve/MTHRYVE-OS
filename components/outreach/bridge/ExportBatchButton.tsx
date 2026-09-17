"use client";

// Bridge → EXPORT. One button that: applies the suppression hard-filter, stamps
// the approved batch (batch_label + exported_at + delivery_status='exported'),
// writes the audit trail (all server-side), and hands back a merge-ready CSV that
// this island downloads in the browser. NO ESP, NO auto-send — the human drops
// this CSV into their free Gmail / Apps Script merge and sends by hand.

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { ExportState } from "@/lib/outreach/bridge-actions";
import type { RecipientType } from "@/lib/outreach/bridge";

function SubmitButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-50"
    >
      {pending ? "Exporting…" : `Export approved batch (${count})`}
    </button>
  );
}

export function ExportBatchButton({
  action,
  recipientType,
  approvedCount,
}: {
  action: (prev: ExportState, formData: FormData) => Promise<ExportState>;
  recipientType: RecipientType;
  approvedCount: number;
}) {
  const [state, formAction] = useFormState(action, null);
  const lastAt = useRef<string | null>(null);

  // When a fresh CSV comes back (state.at changes), trigger a browser download.
  useEffect(() => {
    if (!state?.csv || !state.filename || state.at === lastAt.current) return;
    lastAt.current = state.at;
    const blob = new Blob([state.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [state]);

  return (
    <div className="space-y-2">
      <form action={formAction}>
        <input type="hidden" name="recipient_type" value={recipientType} />
        <SubmitButton count={approvedCount} />
      </form>

      {state?.error && <p className="text-sm text-red-300">{state.error}</p>}
      {state?.csv && (
        <p className="text-sm text-teal-300">
          Exported {state.exported} message{state.exported === 1 ? "" : "s"} as batch{" "}
          <span className="font-mono text-ink">{state.batchLabel}</span> — CSV downloaded. Run it through your Gmail
          merge, then import the results below.
        </p>
      )}
      {state?.suppressed && state.suppressed.length > 0 && (
        <div className="rounded-md border border-charcoal-700 bg-charcoal-900/60 p-2.5">
          <p className="mb-1 text-xs font-semibold text-amber-300">
            {state.suppressed.length} suppressed (excluded pre-export):
          </p>
          <ul className="space-y-0.5 text-[11px] text-ink-muted">
            {state.suppressed.map((s, i) => (
              <li key={i}>
                {s.name} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[11px] text-ink-dim">
        Suppression is enforced here: no-email, do-not-contact, opted-out / prior-bounce, and existing-client domains are
        excluded and listed. Nothing is sent by the OS.
      </p>
    </div>
  );
}
