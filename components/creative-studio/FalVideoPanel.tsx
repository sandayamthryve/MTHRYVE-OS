"use client";

// "Generate video with fal.ai" panel for the content-item editor. fal spends
// real money per clip, so this panel exists to make the cost VISIBLE and force
// an explicit approval before anything is submitted:
//   • pick a model — Kling 3.0 or Luma Ray 2 (cheap drafts, Ray 2 default) or
//     Veo 3.1 Standard (hero shots, flagged ~$6/8s)
//   • enter a text prompt and/or a reference image URL
//   • pick a clip length; a live ESTIMATED COST updates as you change model /
//     duration
//   • a single, role-gated "Approve & Generate" button is the ONLY way to submit
//
// The cost math + model catalog are the shared lib/fal/models module, so this
// live preview and the server action's authoritative recompute can never
// disagree. The button posts to the server action passed in `action`; the server
// re-checks the leadership role and re-computes the cost before it ever calls
// fal. Nothing here ever sees the FAL_KEY — that stays server-side.

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  FAL_VIDEO_MODELS,
  DEFAULT_FAL_MODEL_ID,
  getFalModel,
  estimateFalCostUsd,
  formatUsd,
} from "@/lib/fal/models";

const fieldCls =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink placeholder:text-ink-dim";

function ApproveButton({
  disabled,
  confirmMessage,
}: {
  disabled: boolean;
  confirmMessage: string;
}) {
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
      <span aria-hidden>🎞️</span>
      {pending ? "Submitting to fal…" : "Approve & Generate"}
    </button>
  );
}

export function FalVideoPanel({
  itemId,
  brand,
  month,
  defaultPrompt,
  canGenerate,
  action,
}: {
  itemId: string;
  brand: string;
  month: string;
  defaultPrompt: string;
  canGenerate: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const [modelId, setModelId] = useState(DEFAULT_FAL_MODEL_ID);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [imageUrl, setImageUrl] = useState("");
  const model = getFalModel(modelId) ?? getFalModel(DEFAULT_FAL_MODEL_ID)!;

  // Keep the duration valid for the selected model — reset to the model default
  // whenever the model changes and the current pick isn't offered.
  const [duration, setDuration] = useState(model.defaultDurationSeconds);
  const effectiveDuration = model.durationOptions.includes(duration)
    ? duration
    : model.defaultDurationSeconds;

  const cost = useMemo(
    () => estimateFalCostUsd(model, effectiveDuration),
    [model, effectiveDuration]
  );

  const trimmedPrompt = prompt.trim();
  const trimmedImage = imageUrl.trim();
  // Need at least a prompt OR an image (image→video models still take a prompt,
  // but a lone image is enough to start).
  const ready = trimmedPrompt.length > 0 || trimmedImage.length > 0;

  const confirmMessage =
    `Submit this ${model.label} clip to fal?\n\n` +
    `Estimated cost: ${formatUsd(cost)} ` +
    `(~${effectiveDuration}s at ${formatUsd(model.usdPerSecond)}/s).\n\n` +
    (model.flagExpensive
      ? `⚠ ${model.label} is a HERO-shot model — this is a premium render.\n\n`
      : "") +
    `fal bills real money per clip. This cannot be undone once submitted.`;

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
      <input type="hidden" name="duration" value={effectiveDuration} />

      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
          <span aria-hidden>🎞️</span> Generate video with fal.ai
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
          Async · cost-gated
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Model picker — radio cards, hero models flagged. */}
        <div className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Model
          </span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {FAL_VIDEO_MODELS.map((m) => (
              <label
                key={m.id}
                className={`flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 text-xs ${
                  modelId === m.id
                    ? "border-gold-500/50 bg-gold-500/10 text-gold-200"
                    : "border-charcoal-700 bg-charcoal-950 text-ink-muted hover:bg-charcoal-800"
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="model"
                    value={m.id}
                    checked={modelId === m.id}
                    onChange={() => {
                      setModelId(m.id);
                      setDuration(m.defaultDurationSeconds);
                    }}
                    className="accent-gold-500"
                  />
                  <span className="font-medium">{m.label}</span>
                  {m.flagExpensive && (
                    <span className="rounded bg-red-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-red-200">
                      ~$6/8s
                    </span>
                  )}
                </span>
                <span className="text-[10px] text-ink-dim">{m.hint}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Prompt (defaults to the brief)
          </span>
          <textarea
            name="prompt"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the shot. Pulled from the brief — edit as needed."
            className={fieldCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Reference image URL (optional)
          </span>
          <input
            name="image_url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://…  (image→video)"
            className={fieldCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Clip length
          </span>
          <select
            value={effectiveDuration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className={fieldCls}
          >
            {model.durationOptions.map((d) => (
              <option key={d} value={d}>
                {d}s
              </option>
            ))}
          </select>
        </label>

        {/* Cost preview — the whole point of the gate. Prominent, always visible,
            updates live. */}
        <div className="flex flex-col justify-between gap-2 rounded-lg border border-gold-500/30 bg-gold-500/5 p-3 sm:col-span-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-wider text-gold-300/80">
              Estimated cost
            </span>
            <span className="text-2xl font-semibold text-gold-300">{formatUsd(cost)}</span>
          </div>
          <p className="text-[11px] text-ink-dim">
            ≈ {effectiveDuration}s at {formatUsd(model.usdPerSecond)}/s ({model.label}).
            {model.flagExpensive
              ? " Hero-shot model — reserve for the moments that matter."
              : " Draft model — cheap enough to iterate."}{" "}
            Estimate only; fal bills the actual render. Nothing is submitted until you approve.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          {canGenerate ? (
            <ApproveButton disabled={!ready} confirmMessage={confirmMessage} />
          ) : (
            <span className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-[11px] text-ink-dim">
              🔒 Only leadership can approve &amp; generate fal videos.
            </span>
          )}
          {canGenerate && !ready && (
            <span className="text-[11px] text-ink-dim">
              Add a prompt or a reference image to enable.
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
