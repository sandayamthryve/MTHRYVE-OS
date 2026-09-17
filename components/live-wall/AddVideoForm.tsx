"use client";

// The video-library "paste a link" form. Adding a video is leadership/head-gated
// (videos_write RLS) but the whole org watches. An unsupported link is refused by
// the server action and surfaced inline via useFormState — the operator sees
// "paste a TikTok / YouTube / MP4 link" rather than a silent no-op or a stored
// row the library can't play.

import { useFormState, useFormStatus } from "react-dom";
import type { AddVideoState } from "@/app/(dashboard)/live-wall/actions";

type Brand = { id: string; name: string };

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60 sm:col-span-3"
    >
      {pending ? "Adding…" : "Add to library"}
    </button>
  );
}

export function AddVideoForm({
  action,
  brands,
}: {
  action: (prev: AddVideoState, formData: FormData) => Promise<AddVideoState>;
  brands: Brand[];
}) {
  const [state, formAction] = useFormState(action, null);
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-3">
      <input name="title" placeholder="Video title" className={`${inputCls} sm:col-span-2`} />
      <select name="brand_id" defaultValue="" className={inputCls}>
        <option value="">Brand (optional)…</option>
        {brands.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
      <input
        name="video_url"
        placeholder="Paste a TikTok, YouTube, or .mp4 link"
        className={`${inputCls} sm:col-span-3`}
      />
      <input name="description" placeholder="Description (optional)" className={`${inputCls} sm:col-span-3`} />
      {state?.error && <p className="text-xs text-red-400 sm:col-span-3">{state.error}</p>}
      <SubmitButton />
    </form>
  );
}
