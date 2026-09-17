"use client";

import { SectionCard } from "@/components/ui";
import { useTonyVoice } from "@/lib/voice/useTonyVoice";
import { TonyVoiceOrb } from "@/components/tony/TonyVoiceOrb";

// "Talk to Tony" (push-to-talk) + "Hey Tony" (hands-free) — the JARVIS voice
// surface. It only routes speech into the existing grounded assistant
// (/api/assistant) and reads the reply back; Tony's brain, grounding, memory,
// and personality are UNCHANGED. The spoken question is transcribed by OpenAI
// Whisper (/api/voice/transcribe) and the reply spoken by OpenAI TTS
// (/api/voice/speak) when OPENAI_API_KEY is configured, falling back to the
// browser's built-in Web Speech engines otherwise. The "Hey Tony" wake word runs
// entirely in-browser (free) and is off by default.
export function TonyVoice() {
  const voice = useTonyVoice();
  const {
    state,
    handsFree,
    interim,
    lastTranscript,
    lastReply,
    error,
    openAiAvailable,
    pushToTalkReady,
    handsFreeReady,
  } = voice;

  const capturing = state === "capturing";
  const speaking = state === "speaking";
  const busy = state === "transcribing" || state === "thinking";

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          Talk to Tony
          <span className="rounded-full border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
            Voice
          </span>
        </span>
      }
      action={
        <button
          type="button"
          onClick={voice.toggleHandsFree}
          disabled={!handsFreeReady}
          role="switch"
          aria-checked={handsFree}
          className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
            handsFree
              ? "border-teal-400/60 bg-teal-500/15 text-teal-200"
              : "border-charcoal-700 text-ink-muted hover:border-teal-500/40 hover:text-ink"
          }`}
          title={
            handsFreeReady
              ? "Listen for “Hey Tony” continuously (in-browser, free)"
              : "Hands-free needs the Web Speech API (Chrome or Edge)"
          }
        >
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full ${
              handsFree ? "bg-teal-300 shadow-[0_0_8px] shadow-teal-300" : "bg-ink-dim"
            }`}
          />
          Hey Tony {handsFree ? "on" : "off"}
        </button>
      }
    >
      <div className="flex flex-col items-center gap-6 py-2">
        <TonyVoiceOrb state={state} onClick={voice.talk} disabled={!pushToTalkReady} />

        {/* Primary controls */}
        <div className="flex flex-wrap items-center justify-center gap-3">
          {capturing ? (
            <button
              type="button"
              onClick={voice.stopTalking}
              className="rounded-full bg-teal-500 px-5 py-2 text-sm font-semibold text-charcoal-950 transition hover:bg-teal-400"
            >
              Stop &amp; send
            </button>
          ) : (
            <button
              type="button"
              onClick={voice.talk}
              disabled={!pushToTalkReady || busy}
              className="rounded-full bg-teal-500 px-5 py-2 text-sm font-semibold text-charcoal-950 transition hover:bg-teal-400 disabled:opacity-50"
            >
              🎙 Talk to Tony
            </button>
          )}
          {speaking && (
            <button
              type="button"
              onClick={voice.stopSpeaking}
              className="rounded-full border border-charcoal-700 px-4 py-2 text-sm text-ink-muted transition hover:bg-charcoal-800 hover:text-ink"
            >
              Stop speaking
            </button>
          )}
        </div>

        {/* Live caption / transcript / reply */}
        <div className="w-full max-w-xl space-y-3">
          {capturing && (
            <p className="text-center text-sm text-teal-200">
              {interim ? `“${interim}”` : "Listening…"}
            </p>
          )}

          {lastTranscript && !capturing && (
            <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 px-4 py-2.5">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                You asked
              </div>
              <p className="text-sm text-ink">{lastTranscript}</p>
            </div>
          )}

          {lastReply && (
            <div className="rounded-lg border border-teal-500/25 bg-teal-500/[0.06] px-4 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-teal-300">
                <span aria-hidden>✦</span> Tony
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink">{lastReply}</p>
            </div>
          )}
        </div>

        {/* Errors + honest configuration hints */}
        {error && (
          <div className="flex w-full max-w-xl items-start justify-between gap-3 rounded-lg border border-gold-500/40 bg-gold-500/10 px-4 py-2.5">
            <p className="text-sm text-gold-200">{error}</p>
            <button
              type="button"
              onClick={voice.dismissError}
              className="shrink-0 text-xs text-gold-300 hover:text-gold-200"
            >
              Dismiss
            </button>
          </div>
        )}

        {!pushToTalkReady && !error && (
          <p className="max-w-xl text-center text-xs text-ink-muted">
            Voice input isn't supported in this browser. Chrome or Edge on desktop work best — or
            use the{" "}
            <a href="/assistant" className="text-teal-400 hover:underline">
              typed assistant
            </a>
            .
          </p>
        )}

        {/* Honesty note: what leaves the device, and what stays in-browser. */}
        {pushToTalkReady && (
          <p className="max-w-xl text-center text-[11px] leading-relaxed text-ink-dim">
            {openAiAvailable ? (
              <>
                Your spoken question and Tony's spoken reply are sent to the configured voice
                service (Whisper for speech-to-text, a neural voice for the reply). Tony speaks
                sentence-by-sentence as his answer streams in. The “Hey Tony” wake word is detected
                in-browser and never leaves your device. Tony's answers come from your own grounded
                data — voice only changes how you ask and hear them.
              </>
            ) : (
              <>
                No neural voice is configured, so speech-to-text and the reply voice use your
                browser's built-in Web Speech engines. The “Hey Tony” wake word runs in-browser and
                never leaves your device. Tony's answers come from your own grounded data — voice
                only changes how you ask and hear them.
              </>
            )}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
