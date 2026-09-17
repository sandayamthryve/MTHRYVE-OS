"use client";
// components/creative-studio/VesperJobForm.tsx
// The "New auto-clip job" form for Vesper Studio. A thin client shell: it lets
// the user pick a source (an existing raw video already in creative-media, or a
// URL the worker will fetch), a brand, and a couple of tunables, then submits to
// the server action which enqueues a vesper_clip_jobs row. No video is touched
// here — processing happens in the out-of-runtime worker.

import { useState } from "react";
import { useFormStatus } from "react-dom";

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="rounded-md bg-teal-500/90 px-4 py-2 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-50"
    >
      {pending ? "Queuing…" : "Queue auto-clip job"}
    </button>
  );
}

export function VesperJobForm({
  rawAssets,
  brands,
  brand,
  action,
}: {
  rawAssets: { id: string; title: string }[];
  brands: { id: string; name: string }[];
  brand: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [sourceAssetId, setSourceAssetId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");

  const hasSource = Boolean(sourceAssetId || sourceUrl.trim());

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="brand" value={brand} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Source — raw video in library
          </span>
          <select
            name="source_asset_id"
            value={sourceAssetId}
            onChange={(e) => setSourceAssetId(e.target.value)}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            <option value="">— Choose a raw file —</option>
            {rawAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title || a.id}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-ink-dim">
            Upload long videos to the Library’s “Raw Files” folder first, or paste a URL →
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            …or source URL
          </span>
          <input
            type="url"
            name="source_url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://…/livestream.mp4"
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim"
          />
          <span className="text-[11px] text-ink-dim">
            The worker downloads it into creative-media/raw before clipping.
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Brand (optional)
          </span>
          <select
            name="brand_id"
            defaultValue={brand}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            <option value="">— None —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Max clips
          </span>
          <input
            type="number"
            name="max_clips"
            min={1}
            max={20}
            defaultValue={6}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Aspect
          </span>
          <select
            name="aspect"
            defaultValue="9:16"
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            <option value="9:16">9:16 — vertical (TikTok/Reels)</option>
            <option value="1:1">1:1 — square</option>
            <option value="16:9">16:9 — landscape</option>
          </select>
        </label>
      </div>

      <SubmitButton disabled={!hasSource} />
    </form>
  );
}
