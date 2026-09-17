"use client";

// Small client helpers for the item editor panel: a pending-aware "Generate
// brief" button, a pending-aware Save button, and a confirm-guarded Delete.
// Each is a thin wrapper around a server action passed from the page, so the
// action stays co-located with the data it writes.
import { useFormStatus } from "react-dom";

export function GenerateBriefButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-300 hover:bg-violet-500/20 disabled:opacity-60"
    >
      {pending ? "Generating…" : "Generate brief"}
    </button>
  );
}

export function CreateInCanvaButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-500/20 disabled:opacity-60"
    >
      <span aria-hidden>🎨</span>
      {pending ? "Creating in Canva…" : "Create in Canva"}
    </button>
  );
}

export function SaveButton({ label = "Save content item" }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

function ConfirmDelete({ title }: { title: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(`Delete "${title}"? This can't be undone.`)) {
          e.preventDefault();
        }
      }}
      className="rounded-md bg-charcoal-800 px-3 py-2 text-sm text-red-300 hover:bg-charcoal-700 disabled:opacity-60"
    >
      {pending ? "Deleting…" : "Delete"}
    </button>
  );
}

export function DeleteContentButton({
  id,
  title,
  brand,
  month,
  action,
}: {
  id: string;
  title: string;
  brand: string;
  month: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="brand" value={brand} />
      <input type="hidden" name="month" value={month} />
      <ConfirmDelete title={title} />
    </form>
  );
}
