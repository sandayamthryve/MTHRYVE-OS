"use client";

// "Hey Tony" wake word — FREE and fully IN-BROWSER (this is NOT Whisper).
//
// A continuous Web Speech SpeechRecognition session listens for the phrase and
// only TRIGGERS the flow; the spoken question that follows is what gets captured
// as audio and sent to Whisper. Nothing here goes to any server — the wake word
// never leaves the device. When "Hey Tony" (or a close mishearing) is heard we
// fire onWake once; the caller then chimes, flips the orb to LISTENING, and
// captures the question.
//
// Guardrails baked in here:
//   • auto-restart on end / recoverable error, debounced (continuous
//     recognition auto-stops after silence — we simply start it again);
//   • pause()/resume() so the caller can silence the wake mic while Tony is
//     capturing, transcribing, thinking, or SPEAKING (no self-trigger);
//   • a hard permission-denied path that stops for good and tells the caller.

import { getSpeechRecognitionCtor, type SpeechRecognitionLike } from "./speech";

// "hey tony" plus the mishearings Web Speech commonly returns for it. Kept loose
// on purpose — a false wake just captures a question, which is cheap, whereas a
// missed wake is frustrating.
const WAKE_PATTERNS: RegExp[] = [
  /\bhey,?\s*tony\b/,
  /\bhi,?\s*tony\b/,
  /\bhey,?\s*toni\b/,
  /\bhey,?\s*tonny\b/,
  /\bhey,?\s*tcommy\b/,
  /\bhey,?\s*tommy\b/,
  /\bhey,?\s*tiny\b/,
  /\bhey,?\s*tone\b/,
  /\bhey,?\s*toey\b/,
  /\ba\s*tony\b/,
];

function matchesWake(transcript: string): boolean {
  const t = transcript.toLowerCase();
  return WAKE_PATTERNS.some((p) => p.test(t));
}

export type WakeController = {
  /** Stop listening (e.g. while capturing/thinking/speaking) — resumable. */
  pause: () => void;
  /** Resume listening after a turn settles. */
  resume: () => void;
  /** Permanent teardown (hands-free turned off / unmount). */
  stop: () => void;
};

export type WakeHandlers = {
  onWake: () => void;
  /** Mic permission was denied — hands-free can't run; caller should surface it. */
  onPermissionDenied?: () => void;
};

/**
 * Start the always-on "Hey Tony" listener. Returns a controller, or null if the
 * browser has no SpeechRecognition (caller shows an honest unsupported message;
 * push-to-talk still works everywhere).
 */
export function startWakeWordListener(handlers: WakeHandlers): WakeController | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;

  let recognition: SpeechRecognitionLike | null = null;
  let active = true; // caller wants us listening
  let running = false; // a recognizer is currently started
  let stopped = false; // permanently torn down
  let restartTimer: number | null = null;

  const clearRestart = () => {
    if (restartTimer !== null) {
      window.clearTimeout(restartTimer);
      restartTimer = null;
    }
  };

  const scheduleRestart = (delay = 400) => {
    clearRestart();
    if (stopped || !active) return;
    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      begin();
    }, delay);
  };

  function begin() {
    if (stopped || !active || running) return;
    const rec = new Ctor!();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const alt = event.results[i]?.[0];
        if (alt && matchesWake(alt.transcript)) {
          console.log("[voice] wake word heard");
          handlers.onWake();
          return;
        }
      }
    };

    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        active = false;
        console.warn("[voice] wake word: mic permission denied");
        handlers.onPermissionDenied?.();
        return;
      }
      // "no-speech" / "network" / "aborted" are recoverable — onend restarts.
    };

    rec.onend = () => {
      running = false;
      scheduleRestart();
    };

    recognition = rec;
    try {
      rec.start();
      running = true;
      console.log("[voice] wake word listening");
    } catch {
      // start() throws if called while already running — retry shortly.
      running = false;
      scheduleRestart();
    }
  }

  const pause = () => {
    active = false;
    clearRestart();
    if (recognition && running) {
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
    }
  };

  const resume = () => {
    if (stopped) return;
    active = true;
    if (!running) scheduleRestart(150);
  };

  const stop = () => {
    stopped = true;
    active = false;
    clearRestart();
    if (recognition) {
      try {
        recognition.onend = null;
        recognition.abort();
      } catch {
        /* ignore */
      }
    }
    recognition = null;
  };

  begin();
  return { pause, resume, stop };
}
