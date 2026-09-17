"use client";

// Per-document row controls: Re-ingest (re-run extraction + embedding) and
// Delete (removes the row — chunks cascade — and the stored file). Each is a
// tiny form bound to a server action passed down from the page. Delete is
// confirm-guarded. Split into its own client island so the page stays a server
// component.

import { useFormStatus } from "react-dom";

function ReingestButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink disabled:opacity-60"
    >
      {pending ? "Re-ingesting…" : "Re-ingest"}
    </button>
  );
}

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm("Delete this document and its indexed chunks? This can't be undone.")) {
          e.preventDefault();
        }
      }}
      className="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs text-red-300 hover:bg-charcoal-700 disabled:opacity-60"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}

export function DocRowActions({
  id,
  reingestAction,
  deleteAction,
}: {
  id: string;
  reingestAction: (formData: FormData) => Promise<void>;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <form action={reingestAction}>
        <input type="hidden" name="id" value={id} />
        <ReingestButton />
      </form>
      <form action={deleteAction}>
        <input type="hidden" name="id" value={id} />
        <DeleteButton />
      </form>
    </div>
  );
}
