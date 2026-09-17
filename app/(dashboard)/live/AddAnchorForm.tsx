"use client";

// "Add anchor" is the ONLY path that INSERTs a new `anchors` row. The registry
// row editor (updateAnchor) always UPDATEs by id and can never insert, so a
// duplicate anchor can only ever be born here. The server action guards against
// that by blocking a second anchor that shares a normalized handle on the same
// platform in the org; that block is surfaced inline via useFormState rather than
// thrown, so the operator gets a clear "already exists — open it to edit" instead
// of a silent failure or a duplicate row. The unique index on
// (org_id, lower(handle), platform) is the DB-level backstop.

import { useFormState, useFormStatus } from "react-dom";

export type AddAnchorState = { error: string } | null;

type Option = { value: string; label: string };
type Creator = { id: string; name: string };

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add anchor"}
    </button>
  );
}

export function AddAnchorForm({
  action,
  platforms,
  anchorTypes,
  creators,
}: {
  action: (prev: AddAnchorState, formData: FormData) => Promise<AddAnchorState>;
  platforms: readonly Option[];
  anchorTypes: readonly Option[];
  creators: readonly Creator[];
}) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form
      action={formAction}
      className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <input name="name" required placeholder="Anchor name" className={inputCls} />
        <input name="handle" placeholder="@handle" className={inputCls} />
        <select name="platform" defaultValue="tiktok" className={inputCls}>
          {platforms.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <select name="anchor_type" defaultValue="inhouse" className={inputCls}>
          {anchorTypes.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <select name="creator_id" defaultValue="" className={inputCls}>
          <option value="">Link creator (affiliate)…</option>
          {creators.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <input name="notes" placeholder="Notes (optional)" className={inputCls} />
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
