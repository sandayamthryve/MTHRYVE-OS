// Browser voice primitives for "Talk to Tony" / "Hey Tony" — client-side helpers
// built on Web APIs:
//   • SpeechRecognition (webkitSpeechRecognition) — mic → transcript (the FREE,
//     in-browser fallback engine, and the always-in-browser "Hey Tony" wake word)
//   • SpeechSynthesis — the FALLBACK spoken reply when OpenAI TTS is unavailable
//   • Web Audio — the short, subtle two-note "wake" chime (no asset to ship) and
//     playAudioBlob(), which plays the mp3 that OpenAI TTS returns
//
// The PRIMARY speech path is OpenAI: the spoken question is recorded (see
// recorder.ts) and transcribed by Whisper (/api/voice/transcribe), and the reply
// is synthesized by OpenAI TTS (/api/voice/speak) and played via playAudioBlob().
// Everything here is capability-detected so the surface degrades cleanly to the
// browser engines on browsers without the API (Firefox/Safari lack
// SpeechRecognition today) or when OPENAI_API_KEY isn't configured.

// --- Minimal typings (the Web Speech API isn't in lib.dom yet) --------------

export interface SpeechRecognitionResultLike {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognitionAlternativeList {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionResultEntry {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultEntry;
  [index: number]: SpeechRecognitionResultEntry;
}
export interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}
export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  onstart: ((event: Event) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  webkitAudioContext?: typeof AudioContext;
}

function speechWindow(): SpeechWindow | null {
  return typeof window === "undefined" ? null : (window as SpeechWindow);
}

// --- Capability detection ---------------------------------------------------

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = speechWindow();
  if (!w) return null;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True when this browser can turn microphone speech into a transcript. */
export function speechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/** True when this browser can speak text back (Tony's TTS reply). */
export function speechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// --- Recognition: one utterance → final transcript --------------------------

export type RecognitionHandlers = {
  /** Live partial text while the user is still speaking (for the caption). */
  onInterim?: (text: string) => void;
  /** The settled transcript once the user stops (may be ""). */
  onFinal: (text: string) => void;
  /** Fired on recognition error (e.g. "no-speech", "not-allowed"). */
  onError?: (code: string, message: string) => void;
  /** Always fired when recognition ends, after onFinal/onError. */
  onEnd?: () => void;
};

/**
 * Start a single-utterance recognition session. Returns a stop() handle, or
 * null if the API is unavailable. `continuous = false` so it naturally ends on
 * a pause; we accumulate every final chunk so a multi-part sentence survives.
 */
export function startRecognition(handlers: RecognitionHandlers): (() => void) | null {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = "";
  let stopped = false;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const alt = result[0];
      if (!alt) continue;
      if (result.isFinal) finalText += alt.transcript;
      else interim += alt.transcript;
    }
    if (interim && handlers.onInterim) handlers.onInterim(interim.trim());
  };

  recognition.onerror = (event) => {
    handlers.onError?.(event.error, event.message);
  };

  recognition.onend = () => {
    handlers.onFinal(finalText.trim());
    handlers.onEnd?.();
  };

  try {
    recognition.start();
  } catch {
    // start() throws if called while already running — treat as a no-op.
  }

  return () => {
    if (stopped) return;
    stopped = true;
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  };
}

// --- Synthesis: speak Tony's reply ------------------------------------------

// Markdown-ish artifacts read badly aloud; flatten them to plain prose. The
// on-screen reply still shows the original text — only the spoken copy is
// cleaned.
export function textForSpeech(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " code block ") // fenced code → a word
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^[\s]*[-*+]\s+/gm, "") // bullet markers
    .replace(/(\*\*|__|\*|_|~~)/g, "") // emphasis markers
    .replace(/\s+/g, " ")
    .trim();
}

// --- Streaming sentence extraction ------------------------------------------
// Tony's reply streams in token-by-token; to start speaking almost immediately
// (instead of waiting for the whole message) we peel COMPLETE sentences off the
// front of the growing buffer and speak them one at a time. These helpers are
// pure so they're trivial to reason about and test.

// Index just past the first complete sentence in `buf`, or -1 if none yet. A
// terminator only counts when followed by whitespace, so decimals ("₱3.5M") and
// mid-token dots don't split; a newline always ends a line.
function firstSentenceBoundary(buf: string): number {
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === "\n") return i + 1;
    if (c === "." || c === "!" || c === "?" || c === "…") {
      let j = i + 1;
      // absorb repeated terminators and trailing quotes/brackets
      while (j < buf.length && "\"')]}.!?…".includes(buf[j])) j++;
      if (j >= buf.length) return -1; // terminator at the very end — wait for more
      if (/\s/.test(buf[j])) return j;
    }
  }
  return -1;
}

/**
 * Pull every complete sentence off the front of a streaming `buffer`, returning
 * them plus the unfinished remainder to carry forward. A very long run with no
 * terminator is soft-broken at the last space past `softLimit` so a long clause
 * never stalls speech.
 */
export function extractSentences(
  buffer: string,
  softLimit = 220
): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    let idx = firstSentenceBoundary(rest);
    if (idx < 0) {
      if (rest.length > softLimit) {
        const sp = rest.lastIndexOf(" ", softLimit);
        if (sp > 40) idx = sp + 1;
      }
      if (idx < 0) break;
    }
    const chunk = rest.slice(0, idx).trim();
    if (chunk) sentences.push(chunk);
    rest = rest.slice(idx).replace(/^\s+/, "");
    if (!rest) break;
  }
  return { sentences, rest };
}

let cachedVoice: SpeechSynthesisVoice | null | undefined;

// Prefer a natural en-US voice; fall back to the platform default. Voices load
// asynchronously, so this may return null on the first call and resolve later.
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice ?? null;
  if (!speechSynthesisSupported()) return (cachedVoice = null);
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null; // not loaded yet — don't cache
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const preferred =
    en.find((v) => /natural|google us|samantha|aria|jenny/i.test(v.name)) ??
    en.find((v) => v.lang.toLowerCase() === "en-us") ??
    en[0] ??
    voices[0] ??
    null;
  cachedVoice = preferred;
  return preferred;
}

export type SpeakHandlers = { onEnd?: () => void; onError?: () => void };

/**
 * Speak `text`. Returns a cancel() handle, or null if synthesis is
 * unavailable (the caller should still surface the reply on screen).
 */
export function speak(text: string, handlers: SpeakHandlers = {}): (() => void) | null {
  if (!speechSynthesisSupported()) return null;
  const clean = textForSpeech(text);
  if (!clean) {
    handlers.onEnd?.();
    return null;
  }

  const synth = window.speechSynthesis;
  synth.cancel(); // never overlap replies

  const utterance = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  utterance.rate = 1.02;
  utterance.pitch = 1;
  utterance.onend = () => handlers.onEnd?.();
  utterance.onerror = () => (handlers.onError ?? handlers.onEnd)?.();

  synth.speak(utterance);

  return () => {
    utterance.onend = null;
    utterance.onerror = null;
    synth.cancel();
  };
}

/**
 * Play an mp3/audio Blob (OpenAI TTS output) through an <audio> element. Returns
 * a cancel() handle, or null if playback couldn't start (the caller then falls
 * back to browser speechSynthesis). onEnd fires when the clip finishes, is
 * cancelled, or errors — so the state machine always settles.
 */
export function playAudioBlob(blob: Blob, handlers: SpeakHandlers = {}): (() => void) | null {
  try {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    };
    audio.onended = () => {
      release();
      handlers.onEnd?.();
    };
    audio.onerror = () => {
      release();
      (handlers.onError ?? handlers.onEnd)?.();
    };
    void audio.play().catch(() => {
      release();
      (handlers.onError ?? handlers.onEnd)?.();
    });
    return () => {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
      release();
    };
  } catch {
    handlers.onError?.();
    return null;
  }
}

/** Warm the voice list so the first spoken reply isn't voiceless. */
export function primeVoices(): void {
  if (!speechSynthesisSupported()) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoice = undefined; // re-pick now that the list is populated
    pickVoice();
  };
}

// --- Wake chime (Web Audio) -------------------------------------------------

let audioCtx: AudioContext | null = null;

function ensureAudioContext(): AudioContext | null {
  const w = speechWindow();
  if (!w) return null;
  const Ctor = window.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

/**
 * A subtle two-note rising chime that marks "Hey Tony" being heard. Generated
 * on the fly so there's no audio file to ship, and kept quiet on purpose.
 */
export function playWakeChime(): void {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.0001;
  master.connect(ctx.destination);

  // E5 then B5 — a soft, confident two-note lift.
  const notes = [
    { freq: 659.25, at: 0, dur: 0.12 },
    { freq: 987.77, at: 0.1, dur: 0.22 },
  ];
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = note.freq;
    const start = now + note.at;
    const peak = 0.12;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);
    osc.connect(gain).connect(master);
    osc.start(start);
    osc.stop(start + note.dur + 0.02);
  }
  master.gain.setValueAtTime(1, now);
}

/**
 * Browsers gate audio/mic behind a user gesture. Call this from the click that
 * enables voice so the chime and TTS are allowed to make sound afterwards.
 */
export function unlockAudio(): void {
  ensureAudioContext();
  if (speechSynthesisSupported()) {
    // A muted, empty utterance primes the synth engine within the gesture.
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
    window.speechSynthesis.cancel();
  }
}
