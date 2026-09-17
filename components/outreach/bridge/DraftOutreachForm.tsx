"use client";

// Bridge → DRAFT. Pick a contact (a lead or a creator), optionally add brand /
// campaign / a one-line playbook note, and Vesper composes a personalized EMAIL
// as a 'draft' for review. Drafting is the ONLY automatic step — nothing sends.
// Recipient-agnostic: the same island serves both audiences via `recipientType`.

import { useFormState, useFormStatus } from "react-dom";
import type { DraftState } from "@/lib/outreach/bridge-actions";
import type { RecipientType } from "@/lib/outreach/bridge";

export type ContactOption = { value: string; label: string };

function SubmitButton({ recipientType }: { recipientType: RecipientType }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Drafting…" : `Draft ${recipientType} email`}
    </button>
  );
}

export function DraftOutreachForm({
  action,
  recipientType,
  contacts,
}: {
  action: (prev: DraftState, formData: FormData) => Promise<DraftState>;
  recipientType: RecipientType;
  contacts: ContactOption[];
}) {
  const [state, formAction] = useFormState(action, null);
  const inputClass =
    "w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="recipient_type" value={recipientType} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">
          {recipientType === "lead" ? "Lead" : "Creator"}
          <select name="recipient_id" required className={`mt-1 ${inputClass}`} defaultValue="">
            <option value="" disabled>
              Choose a {recipientType}…
            </option>
            {contacts.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Brand <span className="text-ink-dim">(optional)</span>
          <input name="brand" className={`mt-1 ${inputClass}`} placeholder="e.g. Vesper" />
        </label>
        <label className="text-xs text-ink-muted">
          Campaign <span className="text-ink-dim">(optional)</span>
          <input name="campaign" className={`mt-1 ${inputClass}`} placeholder="e.g. Q3 launch" />
        </label>
        <label className="text-xs text-ink-muted">
          Playbook note <span className="text-ink-dim">(optional)</span>
          <input name="note" className={`mt-1 ${inputClass}`} placeholder="e.g. keep it short, lead with the offer" />
        </label>
      </div>
      <SubmitButton recipientType={recipientType} />
      {state?.error && <p className="text-sm text-red-300">{state.error}</p>}
      {state?.ok && <p className="text-sm text-teal-300">{state.ok}</p>}
      <p className="text-[11px] text-ink-dim">
        Personalization is resolved from this {recipientType}&apos;s real fields — no invented numbers or promises. If an
        AI key isn&apos;t set, a clean deterministic draft is used instead (still $0).
      </p>
    </form>
  );
}
