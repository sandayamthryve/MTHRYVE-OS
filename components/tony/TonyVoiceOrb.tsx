"use client";

import type { VoiceState } from "@/lib/voice/useTonyVoice";

// The JARVIS orb — a single glowing core whose color, motion, and caption read
// out the voice state at a glance. Clicking it is the push-to-talk affordance
// ("Talk to Tony"). Only the visual pulses/ripples animate; nothing here
// fabricates data — it's a status light for the voice pipeline.

type OrbSkin = {
  label: string;
  hint: string;
  core: string; // gradient for the core disc
  halo: string; // blurred aura color
  ring: string; // ripple ring border color
  ripple: boolean; // emit expanding rings (active listening states)
  spin: boolean; // rotate the accent ring (thinking)
};

const SKINS: Record<VoiceState, OrbSkin> = {
  idle: {
    label: "TONY",
    hint: "Tap to talk",
    core: "from-charcoal-700 to-charcoal-800 text-ink-muted",
    halo: "bg-teal-500/10",
    ring: "border-charcoal-700",
    ripple: false,
    spin: false,
  },
  "wake-listening": {
    label: "SAY “HEY TONY”",
    hint: "Hands-free · armed",
    core: "from-teal-400/80 to-teal-600/70 text-charcoal-950",
    halo: "bg-teal-400/20",
    ring: "border-teal-400/50",
    ripple: true,
    spin: false,
  },
  capturing: {
    label: "LISTENING",
    hint: "Ask Tony anything",
    core: "from-teal-300 to-teal-500 text-charcoal-950",
    halo: "bg-teal-300/35",
    ring: "border-teal-300/70",
    ripple: true,
    spin: false,
  },
  transcribing: {
    label: "TRANSCRIBING",
    hint: "Turning speech into text…",
    core: "from-teal-400 to-teal-600 text-charcoal-950",
    halo: "bg-teal-400/25",
    ring: "border-teal-400/60",
    ripple: false,
    spin: true,
  },
  thinking: {
    label: "THINKING",
    hint: "Grounding the answer…",
    core: "from-gold-400 to-gold-500 text-charcoal-950",
    halo: "bg-gold-400/25",
    ring: "border-gold-400/60",
    ripple: false,
    spin: true,
  },
  speaking: {
    label: "SPEAKING",
    hint: "Tony is answering",
    core: "from-green-400 to-green-500 text-charcoal-950",
    halo: "bg-green-400/25",
    ring: "border-green-400/60",
    ripple: true,
    spin: false,
  },
  error: {
    label: "—",
    hint: "Voice paused",
    core: "from-red-500/70 to-red-600/60 text-ink",
    halo: "bg-red-500/15",
    ring: "border-red-500/40",
    ripple: false,
    spin: false,
  },
};

export function TonyVoiceOrb({
  state,
  onClick,
  disabled = false,
}: {
  state: VoiceState;
  onClick: () => void;
  disabled?: boolean;
}) {
  const skin = SKINS[state];
  const busy = state === "capturing" || state === "transcribing";

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={state === "capturing" ? "Stop listening" : "Talk to Tony"}
        aria-pressed={state === "capturing"}
        className="group relative flex h-40 w-40 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {/* Blurred aura */}
        <span
          aria-hidden
          className={`tony-core-pulse absolute inset-0 rounded-full blur-2xl ${skin.halo}`}
        />

        {/* Expanding ripples while actively listening/speaking */}
        {skin.ripple && (
          <>
            <span aria-hidden className={`tony-ping absolute inset-0 rounded-full border ${skin.ring}`} />
            <span
              aria-hidden
              className={`tony-ping absolute inset-0 rounded-full border ${skin.ring}`}
              style={{ animationDelay: "0.8s" }}
            />
          </>
        )}

        {/* Accent ring (spins while thinking / waking) */}
        <span
          aria-hidden
          className={`absolute inset-2 rounded-full border ${skin.ring} ${
            skin.spin ? "tony-orb-spin" : ""
          }`}
        />

        {/* The core disc */}
        <span
          className={`relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br shadow-glow transition-transform duration-300 group-hover:scale-105 group-active:scale-95 ${skin.core}`}
        >
          {busy ? (
            <span className="tony-voice-bars flex h-6 items-end gap-1" aria-hidden>
              <i /> <i /> <i /> <i />
            </span>
          ) : (
            <span className="font-display text-lg font-bold tracking-tight">
              {state === "idle" ? "Tony" : ""}
              {state === "thinking" && "…"}
              {state === "speaking" && "▶"}
              {state === "wake-listening" && "✦"}
              {state === "error" && "!"}
            </span>
          )}
        </span>
      </button>

      {/* State readout */}
      <div className="text-center">
        <div className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-ink">
          {skin.label}
        </div>
        <div className="mt-0.5 text-[11px] text-ink-muted">{skin.hint}</div>
      </div>
    </div>
  );
}
