"use client";

// "Generate video with HeyGen" panel for the content-item editor. HeyGen spends
// real money per render, so this panel exists to make the cost VISIBLE and force
// an explicit approval before anything is submitted:
//   • pick an avatar (HeyGen listAvatars) and a voice (listVoices)
//   • the script defaults to the item's brief, editable here
//   • a live ESTIMATED COST updates as you type / change tier
//   • a single, role-gated "Approve & Generate" button is the ONLY way to submit
//
// The cost math is the shared lib/heygen/cost module, so this live preview and
// the server action's authoritative recompute can never disagree. The button
// posts the selected fields to the server action passed in `action`; the server
// re-checks the leadership role and re-computes the cost before it ever calls
// HeyGen. Nothing here ever sees the API key — that stays server-side.

import { useState } from "react";
import { useFormStatus } from "react-dom";
import {
  AVATAR_TIERS,
  DEFAULT_TIER,
  estimateCostUsd,
  estimateDurationSeconds,
  formatUsd,
  type AvatarTier,
} from "@/lib/heygen/cost";
import type { HeygenAvatar, HeygenVoice } from "@/lib/heygen/client";

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
      <span aria-hidden>🎬</span>
      {pending ? "Submitting to HeyGen…" : "Approve & Generate"}
    </button>
  );
}

export function HeygenGeneratePanel({
  itemId,
  brand,
  month,
  defaultScript,
  avatars,
  voices,
  canGenerate,
  walletEmpty,
  action,
}: {
  itemId: string;
  brand: string;
  month: string;
  defaultScript: string;
  avatars: HeygenAvatar[];
  voices: HeygenVoice[];
  canGenerate: boolean;
  walletEmpty: boolean;
  action: (formData: FormData) => Promise<void>;
}) {
  const [script, setScript] = useState(defaultScript);
  const [tier, setTier] = useState<AvatarTier>(DEFAULT_TIER);
  const [avatarId, setAvatarId] = useState(avatars[0]?.avatar_id ?? "");
  const [voiceId, setVoiceId] = useState(voices[0]?.voice_id ?? "");

  const trimmed = script.trim();
  const seconds = estimateDurationSeconds(script);
  const cost = estimateCostUsd(script, tier);
  const rate = AVATAR_TIERS[tier].ratePerMinuteUsd;

  const listsReady = avatars.length > 0 && voices.length > 0;
  // An exhausted HeyGen quota fails the render outright, so the whole approve
  // flow is blocked until it's topped up — no cost preview can change that.
  const ready = listsReady && !walletEmpty && !!avatarId && !!voiceId && trimmed.length > 0;

  const confirmMessage =
    `Submit this video to HeyGen?\n\n` +
    `Estimated cost: ${formatUsd(cost)} ` +
    `(~${seconds}s at ${formatUsd(rate)}/min, ${AVATAR_TIERS[tier].label}).\n\n` +
    `HeyGen bills real money per render. This cannot be undone once submitted.`;

  return (
    <form action={action} className="mt-4 rounded-lg border border-charcoal-700/60 bg-charcoal-950/60 p-4">
      <input type="hidden" name="id" value={itemId} />
      <input type="hidden" name="brand" value={brand} />
      <input type="hidden" name="month" value={month} />
      {/* Belt-and-suspenders: the server also re-checks the leadership role. This
          flag just marks that the submit came from the explicit approve flow. */}
      <input type="hidden" name="approved" value="yes" />

      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
          <span aria-hidden>🎬</span> Generate video with HeyGen
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
          Async · cost-gated
        </span>
      </div>

      {!listsReady ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
          Couldn’t load avatars/voices from HeyGen. Check the API key on{" "}
          <span className="font-mono">/api/integrations/heygen/diag</span> and try reopening this
          item.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Avatar</span>
            <select
              name="avatar_id"
              value={avatarId}
              onChange={(e) => setAvatarId(e.target.value)}
              className={fieldCls}
            >
              {avatars.map((a) => (
                <option key={a.avatar_id} value={a.avatar_id}>
                  {a.name}
                  {a.gender ? ` · ${a.gender}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Voice</span>
            <select
              name="voice_id"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className={fieldCls}
            >
              {voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                  {v.language ? ` · ${v.language}` : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Avatar tier (drives the rate)
            </span>
            <div className="flex flex-wrap gap-2">
              {(Object.values(AVATAR_TIERS)).map((t) => (
                <label
                  key={t.id}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                    tier === t.id
                      ? "border-gold-500/50 bg-gold-500/10 text-gold-200"
                      : "border-charcoal-700 bg-charcoal-950 text-ink-muted hover:bg-charcoal-800"
                  }`}
                >
                  <input
                    type="radio"
                    name="tier"
                    value={t.id}
                    checked={tier === t.id}
                    onChange={() => setTier(t.id)}
                    className="accent-gold-500"
                  />
                  <span className="font-medium">{t.label}</span>
                  <span className="text-ink-dim">{t.hint}</span>
                </label>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Script (defaults to the brief)
            </span>
            <textarea
              name="script"
              rows={5}
              value={script}
              onChange={(e) => setScript(e.target.value)}
              placeholder="What the avatar will say. Pulled from the brief — edit as needed."
              className={fieldCls}
            />
          </label>

          {/* Cost preview — the whole point of the gate. Prominent, always
              visible, updates live. */}
          <div className="flex flex-col justify-between gap-2 rounded-lg border border-gold-500/30 bg-gold-500/5 p-3 sm:col-span-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-gold-300/80">
                Estimated cost
              </span>
              <span className="text-2xl font-semibold text-gold-300">{formatUsd(cost)}</span>
            </div>
            <p className="text-[11px] text-ink-dim">
              ≈ {seconds}s at {formatUsd(rate)}/min ({AVATAR_TIERS[tier].label}). Estimate from script
              length; HeyGen bills the actual render. Nothing is submitted until you approve.
            </p>
          </div>

          {/* Wallet gate — an empty HeyGen quota blocks the whole flow; no
              amount of picking avatars/scripts can proceed until it's topped
              up, so this takes precedence over the field-completeness hint. */}
          {walletEmpty && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-[12px] text-red-200 sm:col-span-2">
              HeyGen wallet empty — top up to generate.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            {canGenerate ? (
              <ApproveButton disabled={!ready} confirmMessage={confirmMessage} />
            ) : (
              <span className="rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2 text-[11px] text-ink-dim">
                🔒 Only leadership can approve &amp; generate HeyGen videos.
              </span>
            )}
            {canGenerate && !ready && !walletEmpty && (
              <span className="text-[11px] text-ink-dim">
                Pick an avatar &amp; voice and add a script to enable.
              </span>
            )}
          </div>
        </div>
      )}
    </form>
  );
}
