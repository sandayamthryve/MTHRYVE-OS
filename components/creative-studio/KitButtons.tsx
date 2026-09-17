"use client";

// Pending-aware submit buttons for the Creative Kit panel in the item editor.
// Each is a thin client wrapper around a server action passed from the page, so
// the write stays co-located with the data it touches (same idiom as the
// content-calendar EditorButtons). Nothing here reads the DB or a secret.
import { useFormStatus } from "react-dom";

export function AttachAssetButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-500/20 disabled:opacity-60"
    >
      <span aria-hidden>＋</span>
      {pending ? "Attaching…" : "Attach asset"}
    </button>
  );
}

export function SaveCapcutButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-charcoal-800 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save CapCut link"}
    </button>
  );
}

function RemoveInner({ title }: { title: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(`Remove "${title}" from the kit?`)) e.preventDefault();
      }}
      className="rounded-md px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10 disabled:opacity-60"
    >
      {pending ? "Removing…" : "Remove"}
    </button>
  );
}

export function RemoveAssetButton({
  assetId,
  title,
  itemId,
  brand,
  month,
  action,
}: {
  assetId: string;
  title: string;
  itemId: string;
  brand: string;
  month: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="asset_id" value={assetId} />
      <input type="hidden" name="item_id" value={itemId} />
      <input type="hidden" name="brand" value={brand} />
      <input type="hidden" name="month" value={month} />
      <RemoveInner title={title} />
    </form>
  );
}
