"use client";

import { useFormState, useFormStatus } from "react-dom";
import { makePermanent, type PromoteState } from "@/app/(dashboard)/people/actions";

// "Make Permanent" — the promote-out-of-probation control on the People roster.
// Shown to leadership AND department heads (broader than the full editor, which
// is ceo/coo only), so it's a standalone island rather than a field in that
// modal. The server action enforces the real gate; this just posts the id.

function PromoteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500/90 px-2.5 py-1 text-xs font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Make Permanent"}
    </button>
  );
}

export function MakePermanentButton({ personId }: { personId: string }) {
  const initial: PromoteState = { ok: false };
  const [state, formAction] = useFormState(makePermanent, initial);

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="id" value={personId} />
      <PromoteButton />
      {state.error && <span className="text-[11px] text-red-300">{state.error}</span>}
    </form>
  );
}
