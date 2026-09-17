"use client";

// Sourcing → add one creator to a campaign. This is one of the two paths that
// can LINK a creator to a campaign; the dedup rule (a matching email links the
// existing creator instead of minting a new one) and the UNIQUE(campaign,
// creator) collision ("already on this campaign") both surface inline here via
// useFormState — never as a thrown 500. Success clears the form for the next add.

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import type { AddSourcedState } from "@/app/(dashboard)/affiliate/actions";

const fieldCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

type Option = { value: string; label: string };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add / link creator"}
    </button>
  );
}

export function AddSourcedCreatorForm({
  action,
  campaignId,
  platforms,
}: {
  action: (prev: AddSourcedState, formData: FormData) => Promise<AddSourcedState>;
  campaignId: string;
  platforms: readonly Option[];
}) {
  const [state, formAction] = useFormState(action, null);
  const ref = useRef<HTMLFormElement>(null);

  // Clear the inputs after a successful add so the next creator starts fresh
  // (the campaign_id hidden field is re-seeded by defaultValue on reset).
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);

  return (
    <form
      ref={ref}
      action={formAction}
      className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate"
    >
      <input type="hidden" name="campaign_id" defaultValue={campaignId} />
      <h3 className="mb-3 text-sm font-semibold text-ink">Add creator to this campaign</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <input name="name" placeholder="Creator name" className={fieldCls} />
        <input name="handle" placeholder="Handle (e.g. @creator)" className={fieldCls} />
        <select name="platform" defaultValue="tiktok" aria-label="Platform" className={fieldCls}>
          {platforms.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <input name="email" type="email" placeholder="Email (dedups — links existing)" className={fieldCls} />
        <input name="phone" placeholder="Phone" className={fieldCls} />
        <input name="follower_count" type="number" min="0" placeholder="Follower count" className={fieldCls} />
        <input name="category" placeholder="Category (e.g. Beauty)" className={`${fieldCls} sm:col-span-3`} />
      </div>
      {state?.error && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="mt-3 rounded-md border border-teal-500/30 bg-teal-500/5 p-2.5 text-xs text-teal-200">
          {state.ok}
        </p>
      )}
      <SubmitButton />
      <p className="mt-2 text-[11px] text-ink-dim">
        A creator whose email already exists in your org is linked, never duplicated. Leave the
        email blank to always mint a fresh prospect.
      </p>
    </form>
  );
}
