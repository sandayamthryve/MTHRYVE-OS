"use client";

// "Add a client" is the ONLY path that INSERTs a new canonical `brands` row.
// The edit form (updateClient) always UPDATEs by id and can never insert, so a
// duplicate can only ever be born here. The server action guards against that by
// blocking a second active brand with the same normalized name in the org; that
// block is surfaced inline via useFormState rather than thrown, so the operator
// gets a clear "already exists — open it to edit" instead of a silent failure or
// a duplicate row. A partial unique index is the DB-level backstop.

import { useFormState, useFormStatus } from "react-dom";

export type AddClientState = { error: string } | null;

type Option = { value: string; label: string };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-4 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add client"}
    </button>
  );
}

export function AddClientForm({
  action,
  fieldCls,
  platforms,
  tiers,
  onboarding,
}: {
  action: (prev: AddClientState, formData: FormData) => Promise<AddClientState>;
  fieldCls: string;
  platforms: readonly Option[];
  tiers: readonly Option[];
  onboarding: readonly Option[];
}) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form
      action={formAction}
      className="mb-8 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate"
    >
      <h2 className="mb-3 text-base font-semibold text-ink">Add a client</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="name" required placeholder="Display name *" className={fieldCls} />
        <input name="legal_name" placeholder="Legal / company name" className={fieldCls} />
        <input name="category" placeholder="Category (e.g. Apparel, Home)" className={fieldCls} />
        <input name="gmv_share" type="number" step="any" placeholder="GMV share % (optional)" className={fieldCls} />
        <select name="account_tier" defaultValue="" className={fieldCls}>
          <option value="">Account tier…</option>
          {tiers.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <select name="onboarding_status" defaultValue="onboarding" className={fieldCls}>
          {onboarding.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <input name="primary_contact_name" placeholder="Primary contact name" className={fieldCls} />
        <input name="primary_contact_email" type="email" placeholder="Primary contact email" className={fieldCls} />
        <input name="primary_contact_phone" placeholder="Primary contact phone" className={fieldCls} />
      </div>
      <div className="mt-3">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Platform focus</p>
        <div className="flex flex-wrap gap-4">
          {platforms.map((p) => (
            <label key={p.value} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name={`platform_${p.value}`} className="h-4 w-4 rounded border-charcoal-700 bg-charcoal-950 text-teal-500" />
              {p.label}
            </label>
          ))}
        </div>
      </div>
      {state?.error && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
          {state.error}
        </p>
      )}
      <SubmitButton />
    </form>
  );
}
