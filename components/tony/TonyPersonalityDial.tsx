"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  DEFAULT_TONE,
  TONE_DIMENSIONS,
  TONE_PRESETS,
  TONE_UI_NOTE,
  matchPreset,
  type ToneDimension,
  type TonePreset,
  type ToneSettings,
} from "@/lib/assistant/tone";

// Tony's Personality Dial (TARS-style). Four sliders + named presets that tune
// HOW Tony phrases grounded answers — never what's true. Saves the caller's own
// row in assistant_settings via the RLS-scoped browser client (upsert on
// org_id,user_id), so the org boundary + "own row only" policy are enforced in
// Postgres, not here. The values feed the TONE MODIFIER prepended to every
// grounded assistant call server-side.
export function TonyPersonalityDial({
  orgId,
  userId,
  settings: initial,
}: {
  orgId: string;
  userId: string;
  settings: ToneSettings;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [values, setValues] = useState<Omit<ToneSettings, "preset">>({
    directness: initial.directness,
    warmth: initial.warmth,
    humor: initial.humor,
    brevity: initial.brevity,
  });
  const [saved, setSaved] = useState<Omit<ToneSettings, "preset">>(values);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "err">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const activePreset: TonePreset = matchPreset(values);
  const dirty =
    values.directness !== saved.directness ||
    values.warmth !== saved.warmth ||
    values.humor !== saved.humor ||
    values.brevity !== saved.brevity;

  function setDim(key: ToneDimension, v: number) {
    setStatus("idle");
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function applyPreset(preset: (typeof TONE_PRESETS)[number]) {
    setStatus("idle");
    setValues({ ...preset.values });
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setStatus("idle");
    setMessage(null);

    const preset = matchPreset(values);
    const row = {
      org_id: orgId,
      user_id: userId,
      preset,
      directness: values.directness,
      warmth: values.warmth,
      humor: values.humor,
      brevity: values.brevity,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("assistant_settings")
      .upsert(row as never, { onConflict: "org_id,user_id" });

    if (error) {
      setStatus("err");
      setMessage(error.message);
    } else {
      setStatus("ok");
      setSaved({ ...values });
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <div>
      {/* Presets */}
      <div className="mb-4">
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-ink-dim">
          Presets
        </p>
        <div className="flex flex-wrap gap-1.5">
          {TONE_PRESETS.map((p) => {
            const active = activePreset === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p)}
                title={p.blurb}
                className={`rounded-md border px-2.5 py-1 text-xs transition ${
                  active
                    ? "border-teal-500 bg-teal-500/15 text-teal-200"
                    : "border-charcoal-700 text-ink-muted hover:border-charcoal-600 hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <span
            title="Your own hand-tuned mix."
            className={`rounded-md border px-2.5 py-1 text-xs ${
              activePreset === "custom"
                ? "border-teal-500 bg-teal-500/15 text-teal-200"
                : "border-charcoal-800 text-ink-dim"
            }`}
          >
            Custom
          </span>
        </div>
      </div>

      {/* Sliders */}
      <div className="space-y-4">
        {TONE_DIMENSIONS.map((d) => (
          <div key={d.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label htmlFor={`tone-${d.key}`} className="text-xs font-medium text-ink">
                {d.label}
              </label>
              <span className="font-mono text-[10px] text-ink-dim" title={d.hint}>
                {values[d.key]}
              </span>
            </div>
            <input
              id={`tone-${d.key}`}
              type="range"
              min={0}
              max={100}
              step={5}
              value={values[d.key]}
              onChange={(e) => setDim(d.key, Number(e.target.value))}
              className="w-full accent-teal-500"
              aria-label={`${d.label} (${d.low} to ${d.high})`}
            />
            <div className="mt-0.5 flex justify-between font-mono text-[10px] uppercase tracking-wider text-ink-dim">
              <span>{d.low}</span>
              <span>{d.high}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Hard rule — shown under the sliders, verbatim intent of the system rule. */}
      <p className="mt-4 rounded-md border border-charcoal-700 bg-charcoal-950/60 px-3 py-2 text-[11px] leading-snug text-ink-muted">
        <span className="font-medium text-ink">{TONE_UI_NOTE}</span> The dial changes Tony&apos;s
        delivery only — never the facts, numbers, tool results, or willingness to surface bad
        news.
      </p>

      {/* Save */}
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded-md bg-teal-500 px-3.5 py-1.5 text-xs font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {status === "ok" && !dirty && (
          <span className="text-xs text-teal-300">Saved.</span>
        )}
        {status === "err" && (
          <span className="text-xs text-red-300">{message ?? "Could not save."}</span>
        )}
        {dirty && status !== "err" && (
          <span className="text-xs text-ink-dim">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}

// Convenience default export of the shape a fresh user starts from, so a page
// that fails to load a row can still render the panel at the Operator preset.
export const TONY_PERSONALITY_DEFAULT: ToneSettings = DEFAULT_TONE;
