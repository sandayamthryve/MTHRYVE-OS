"use client";

// "Assemble listing video" panel for the content-item editor. JSON2Video spends
// real money per render, so this panel exists to make the cost VISIBLE and force
// an explicit approval before anything is submitted:
//   • it composes the item's Creative Kit — HeyGen/fal clips + Canva visuals +
//     captions + music/voiceover — into ONE finished MP4 via a template
//   • pick an output resolution; a live ESTIMATED COST updates as you change it
//   • a single, role-gated "Approve & Render" button is the ONLY way to submit
//
// The cost math + asset selection are the shared lib/json2video/assembly module,
// so this live preview and the server action's authoritative recompute can never
// disagree. The button posts to the server action passed in `action`; the server
// re-checks the leadership role, re-selects the assets and re-computes the cost
// before it ever calls JSON2Video. Nothing here ever sees the JSON2VIDEO_API_KEY
// — that stays server-side.

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  ASSEMBLY_RESOLUTIONS,
  DEFAULT_RESOLUTION_ID,
  getResolution,
  selectAssemblyAssets,
  estimateAssemblyDurationSeconds,
  estimateAssemblyCostUsd,
  hasRenderableScenes,
  formatUsd,
  type AssemblySourceAsset,
} from "@/lib/json2video/assembly";

function ApproveButton({ disabled, confirmMessage }: { disabled: boolean; confirmMessage: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-gold-500/50 bg-gold-500/15 px-4 py-2 text-sm font-semibold text-gold-300 hover:bg-gold-500/25 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span aria-hidden>🎥</span>
      {pending ? "Submitting to JSON2Video…" : "Approve & Render"}
    </button>
  );
}

// A compact "what's going into the cut" line so the approver sees the composition
// before spending. Zero-count pieces are omitted.
function CompositionSummary({
  clips,
  visuals,
  captions,
  music,
  voiceover,
}: {
  clips: number;
  visuals: number;
  captions: number;
  music: boolean;
  voiceover: boolean;
}) {
  const parts: string[] = [];
  if (clips) parts.push(`${clips} clip${clips === 1 ? "" : "s"}`);
  if (visuals) parts.push(`${visuals} visual${visuals === 1 ? "" : "s"}`);
  if (captions) parts.push(`${captions} caption${captions === 1 ? "" : "s"}`);
  if (music) parts.push("music");
  if (voiceover) parts.push("voiceover");
  return (
    <p className="text-[11px] text-ink-dim">
      {parts.length ? `Composing ${parts.join(" · ")}.` : "Nothing renderable in the kit yet."}
    </p>
  );
}

export function AssemblyPanel({
  itemId,
  brand,
  month,
  assets,
  canAssemble,
  configured,
  action,
}: {
  itemId: string;
  brand: string;
  month: string;
  // The item's ready Creative Kit assets, trimmed to what the composer needs.
  assets: AssemblySourceAsset[];
  canAssemble: boolean;
  configured: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const [resolutionId, setResolutionId] = useState(DEFAULT_RESOLUTION_ID);
  const resolution = getResolution(resolutionId) ?? getResolution(DEFAULT_RESOLUTION_ID)!;

  // Categorise + price live from the same shared module the server re-runs.
  const selection = useMemo(() => selectAssemblyAssets(assets), [assets]);
  const seconds = useMemo(() => estimateAssemblyDurationSeconds(selection), [selection]);
  const cost = useMemo(
    () => estimateAssemblyCostUsd(selection, resolution),
    [selection, resolution]
  );
  const renderable = hasRenderableScenes(selection);

  const confirmMessage =
    `Assemble this listing video with JSON2Video?\n\n` +
    `Estimated cost: ${formatUsd(cost)} ` +
    `(~${seconds}s at ${resolution.label}).\n\n` +
    `JSON2Video bills real money per render. This cannot be undone once submitted.`;

  // Graceful no-key state — matches the rest of the integration surfaces.
  if (!configured) {
    return (
      <div className="mt-4 rounded-lg border border-charcoal-700/60 bg-charcoal-950/60 p-4">
        <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink">
          <span aria-hidden>🎥</span> Assemble listing video
        </div>
        <p className="text-[11px] text-ink-dim">
          JSON2Video isn’t set up yet (missing JSON2VIDEO_API_KEY). Once the key is added, you can
          compose this item’s clips, visuals, captions and music into one finished MP4.
        </p>
      </div>
    );
  }

  return (
    <form
      action={action}
      className="mt-4 rounded-lg border border-charcoal-700/60 bg-charcoal-950/60 p-4"
    >
      <input type="hidden" name="id" value={itemId} />
      <input type="hidden" name="brand" value={brand} />
      <input type="hidden" name="month" value={month} />
      {/* Belt-and-suspenders: the server also re-checks the leadership role. This
          flag just marks that the submit came from the explicit approve flow. */}
      <input type="hidden" name="approved" value="yes" />
      <input type="hidden" name="resolution" value={resolution.id} />

      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
          <span aria-hidden>🎥</span> Assemble listing video
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
          Async · cost-gated
        </span>
      </div>

      <div className="mb-3">
        <CompositionSummary
          clips={selection.clips.length}
          visuals={selection.visuals.length}
          captions={selection.captions.length}
          music={Boolean(selection.music)}
          voiceover={Boolean(selection.voiceover)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3">
        {/* Resolution picker — radio cards. Higher resolution → higher $/s. */}
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Output resolution
          </span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {ASSEMBLY_RESOLUTIONS.map((r) => (
              <label
                key={r.id}
                className={`flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 text-xs ${
                  resolutionId === r.id
                    ? "border-gold-500/50 bg-gold-500/10 text-gold-200"
                    : "border-charcoal-700 bg-charcoal-950 text-ink-muted hover:bg-charcoal-800"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="resolution_pick"
                    value={r.id}
                    checked={resolutionId === r.id}
                    onChange={() => setResolutionId(r.id)}
                    className="accent-gold-500"
                  />
                  <span className="font-medium">{r.label}</span>
                </span>
                <span className="text-[10px] text-ink-dim">{r.hint}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Cost preview — the whole point of the gate. Prominent, live. */}
        <div className="flex flex-col justify-between gap-2 rounded-lg border border-gold-500/30 bg-gold-500/5 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-wider text-gold-300/80">
              Estimated cost
            </span>
            <span className="text-2xl font-semibold text-gold-300">{formatUsd(cost)}</span>
          </div>
          <p className="text-[11px] text-ink-dim">
            ≈ {seconds}s at {resolution.label} ({formatUsd(resolution.usdPerSecond)}/s). Estimate
            only; JSON2Video bills the actual render. Nothing is submitted until you approve.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {canAssemble ? (
            <ApproveButton disabled={!renderable} confirmMessage={confirmMessage} />
          ) : (
            <span className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-[11px] text-ink-dim">
              🔒 Only leadership can approve &amp; render assembled videos.
            </span>
          )}
          {canAssemble && !renderable && (
            <span className="text-[11px] text-ink-dim">
              Add at least one clip or visual to the Creative Kit to enable.
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
