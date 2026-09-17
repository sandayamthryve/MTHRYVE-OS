// components/live/GoLiveCapture.tsx
// PR 6 — the mobile-first ONE-TAP "START LIVE" capture. Built for someone
// mid-stream with their hands full: pick a host (or type a new one — it is
// created and registered on the spot), optionally a brand, and tap the one big
// button. The server action (startLive) opens a single live_sessions row
// (status='live', started_at=now, source='manual', external_id=NULL) and it
// appears instantly in the LIVE NOW strip with its ticking timer. Idempotent by
// construction — starting an anchor that is already live never opens a second.
//
// Deliberately dumb: no client JS, no metric fields. GMV / viewers / CTOR are
// never entered here; they stay NULL and render "—" until (and unless) someone
// records them post-live. One tap in, one tap out (END LIVE lives on the card).

type Option = { id: string; name: string };

export function GoLiveCapture({
  action,
  anchors,
  brands,
}: {
  action: (formData: FormData) => void | Promise<void>;
  anchors: Option[];
  brands: Option[];
}) {
  const selectCls =
    "w-full rounded-lg border border-charcoal-700 bg-charcoal-950 p-3 text-sm text-ink";
  return (
    <section className="mb-6 rounded-2xl border border-red-500/30 bg-gradient-to-b from-red-500/[0.07] to-charcoal-950 p-4 shadow-elevate">
      <div className="mb-3 flex items-center gap-2">
        <span aria-hidden className="relative flex h-2.5 w-2.5">
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-muted">
          Go live — one tap
        </h2>
      </div>

      <form action={action} className="flex flex-col gap-3">
        {/* Host: pick a registered anchor, OR type a new name (create-or-select).
            The action requires a host and dedupes by name, so one tap both opens
            the live AND fills the anchor registry. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[10px] uppercase tracking-wider text-ink-muted">
            Host
            <select name="anchor_id" defaultValue="" className={`${selectCls} mt-1`}>
              <option value="">New host…</option>
              {anchors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[10px] uppercase tracking-wider text-ink-muted">
            …or new host name
            <input
              name="host_name"
              autoComplete="off"
              placeholder="e.g. Maria"
              className={`${selectCls} mt-1`}
            />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[10px] uppercase tracking-wider text-ink-muted">
            Brand <span className="text-ink-dim">(optional)</span>
            <select name="brand_id" defaultValue="" className={`${selectCls} mt-1`}>
              <option value="">No brand</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[10px] uppercase tracking-wider text-ink-muted">
            Title <span className="text-ink-dim">(optional)</span>
            <input
              name="title"
              autoComplete="off"
              placeholder="e.g. Evening flash sale"
              className={`${selectCls} mt-1`}
            />
          </label>
        </div>
        <input type="hidden" name="platform" value="tiktok_shop" />

        {/* The one tap. Big, thumb-sized, unmistakable. */}
        <button
          type="submit"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-4 text-base font-bold uppercase tracking-wide text-white shadow-elevate transition hover:bg-red-400 active:scale-[0.99]"
        >
          <span aria-hidden className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" />
          Start live
        </button>
        <p className="text-center text-[11px] text-ink-dim">
          Pick or name a host and tap once. Metrics stay “—” until you record them.
        </p>
      </form>
    </section>
  );
}
