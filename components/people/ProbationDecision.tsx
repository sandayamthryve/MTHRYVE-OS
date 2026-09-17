"use client";

import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  regularizeProbation,
  extendProbation,
  releaseProbation,
  type ProbationDecisionState,
} from "@/app/(dashboard)/people/actions";

// The per-hire decision controls on the Probation queue: Regularize · Extend ·
// Release. Each is a self-contained button that opens a small modal (mirroring
// ContractorEditor's pattern) so the confirmation, the optional note, and — for
// Extend — the new date, don't bloat the table row. The server action enforces
// the real gate (requireRole + canManageProbation) and does the service-role
// writes; these components only present the form and post the fields.

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal-500";
const labelCls = "block text-[11px] font-medium uppercase tracking-wide text-ink-muted";

type ActionFn = (
  prev: ProbationDecisionState,
  formData: FormData
) => Promise<ProbationDecisionState>;

function SubmitButton({ label, tone }: { label: string; tone: "teal" | "red" }) {
  const { pending } = useFormStatus();
  const cls =
    tone === "red"
      ? "bg-red-500/90 text-white hover:bg-red-500"
      : "bg-teal-500 text-charcoal-950 hover:bg-teal-400";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-60 ${cls}`}
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

// One decision modal. `children` renders any decision-specific fields (Extend's
// date input); everything else — the trigger button, the note field, the
// dialog chrome and the success-close — is shared.
function DecisionModal({
  personId,
  personName,
  action,
  triggerLabel,
  triggerCls,
  title,
  intro,
  confirmLabel,
  confirmTone,
  children,
}: {
  personId: string;
  personName: string;
  action: ActionFn;
  triggerLabel: string;
  triggerCls: string;
  title: string;
  intro: string;
  confirmLabel: string;
  confirmTone: "teal" | "red";
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState(action, { ok: false } as ProbationDecisionState);

  // Close on a successful decision (the action has already revalidated).
  useEffect(() => {
    if (state.ok && open) setOpen(false);
  }, [state.ok]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={triggerCls}>
        {triggerLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={`${title} — ${personName}`}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-charcoal-700 bg-charcoal-900 shadow-elevate">
            <div className="flex items-center justify-between border-b border-charcoal-700/70 p-4">
              <div>
                <h2 className="text-sm font-semibold text-ink">{title}</h2>
                <p className="text-xs text-ink-muted">{personName}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="rounded-md p-1.5 text-ink-muted hover:bg-charcoal-800 hover:text-ink"
              >
                ✕
              </button>
            </div>

            <form action={formAction} className="p-4">
              <input type="hidden" name="id" value={personId} />
              <p className="mb-3 text-sm text-ink-muted">{intro}</p>
              {children}
              <label className={`${labelCls} mt-3`}>
                Note <span className="normal-case text-ink-dim">(optional)</span>
                <textarea
                  name="note"
                  rows={2}
                  placeholder="Context for the record — e.g. performance summary."
                  className={inputCls}
                />
              </label>

              {state.error && (
                <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {state.error}
                </p>
              )}

              <div className="mt-4 flex items-center justify-end gap-2 border-t border-charcoal-700/70 pt-4">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md bg-charcoal-800 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-700"
                >
                  Cancel
                </button>
                <SubmitButton label={confirmLabel} tone={confirmTone} />
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export function ProbationDecision({
  person,
}: {
  person: { id: string; full_name: string; probation_end: string | null };
}) {
  // A sensible default for the Extend picker: two weeks past the current end (or
  // today when there's no end on file). Purely a starting value — HR picks the
  // real date.
  const base = person.probation_end ? new Date(`${person.probation_end}T00:00:00Z`) : new Date();
  const suggested = new Date(base.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DecisionModal
        personId={person.id}
        personName={person.full_name}
        action={regularizeProbation}
        triggerLabel="Regularize"
        triggerCls="rounded-md bg-teal-500/90 px-2.5 py-1 text-xs font-semibold text-charcoal-950 hover:bg-teal-400"
        title="Regularize hire"
        intro={`Confirm ${person.full_name} has passed probation. Their status becomes “active”.`}
        confirmLabel="Regularize"
        confirmTone="teal"
      />

      <DecisionModal
        personId={person.id}
        personName={person.full_name}
        action={extendProbation}
        triggerLabel="Extend"
        triggerCls="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs font-semibold text-amber-300 hover:bg-charcoal-700"
        title="Extend probation"
        intro="Set a new probation end date. The hire stays on probation until then."
        confirmLabel="Extend"
        confirmTone="teal"
      >
        <label className={labelCls}>
          New probation end
          <input
            name="new_probation_end"
            type="date"
            required
            defaultValue={suggested}
            className={inputCls}
          />
        </label>
      </DecisionModal>

      <DecisionModal
        personId={person.id}
        personName={person.full_name}
        action={releaseProbation}
        triggerLabel="Release"
        triggerCls="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs font-semibold text-red-300 hover:bg-charcoal-700"
        title="Release hire"
        intro={`Confirm ${person.full_name} did not pass probation. Their status becomes “released”. This does not delete their record.`}
        confirmLabel="Release"
        confirmTone="red"
      />
    </div>
  );
}
