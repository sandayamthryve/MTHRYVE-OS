"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  extractSentences,
  playAudioBlob,
  playWakeChime,
  primeVoices,
  speak,
  speechRecognitionSupported,
  speechSynthesisSupported,
  startRecognition,
  textForSpeech,
  unlockAudio,
} from "./speech";
import {
  mediaRecorderSupported,
  startCapture,
  type AudioCapture,
} from "./recorder";
import { startWakeWordListener, type WakeController } from "./wakeword";
import { openAssistantStream } from "@/lib/assistant/client-stream";

// The voice state machine for "Talk to Tony" (push-to-talk) and "Hey Tony"
// (hands-free). Voice ONLY changes how a question gets IN and how the answer
// comes OUT — the GROUNDED BRAIN IS UNCHANGED: the transcript is handed to the
// existing /api/assistant (Claude + the caller's RLS-scoped data) untouched, and
// its text reply is what we speak. Nothing here changes what Tony knows.
//
//   idle ──talk()──────────► capturing ─► transcribing ─► thinking ─► speaking ─► idle
//    │                          ▲                                                   ▲
//    └─handsFree─► wake-listening┘  "Hey Tony" (in-browser, free) → chime ──────────┘
//
// PRIMARY path (OpenAI configured): the spoken question is recorded with
// MediaRecorder and transcribed by Whisper (/api/voice/transcribe); the reply is
// synthesized by OpenAI TTS (/api/voice/speak). FALLBACK (no OPENAI_API_KEY, or a
// voice route errors): the browser's Web Speech recognition + speechSynthesis.
// The "Hey Tony" wake word is ALWAYS in-browser and free either way.
//
// Guards: (1) no self-trigger — the wake mic is paused the moment a turn starts
// and only resumes after Tony's audio ends; (2) the wake recognizer auto-restarts
// on end/recoverable error, debounced (in wakeword.ts); (3) one shared state
// machine; (4) honest mic-permission + unsupported-browser messaging, and
// push-to-talk works everywhere a mic does.
export type VoiceState =
  | "idle"
  | "wake-listening" // hands-free armed, waiting for "Hey Tony"
  | "capturing" // recording / hearing the user's question
  | "transcribing" // Whisper is turning the audio into text
  | "thinking" // grounded /api/assistant is answering
  | "speaking" // reading the reply back
  | "error";

export type VoiceSupport = { recognition: boolean; synthesis: boolean };

type VoiceBackend = { hasOpenAiKey: boolean; whisper: boolean; openAiTts: boolean };

export type TonyVoice = {
  state: VoiceState;
  handsFree: boolean;
  /** Live partial transcript (browser-STT path only; Whisper has no interim). */
  interim: string;
  /** The last settled question sent to Tony. */
  lastTranscript: string;
  /** Tony's last reply (shown on screen even when TTS is unavailable). */
  lastReply: string;
  error: string | null;
  support: VoiceSupport;
  /** True once the OpenAI voice backend is confirmed reachable. */
  openAiAvailable: boolean;
  /** Whether push-to-talk can run in this browser (mic + a capture engine). */
  pushToTalkReady: boolean;
  /** Whether hands-free "Hey Tony" can run (needs Web Speech for the wake word). */
  handsFreeReady: boolean;
  /** Push-to-talk: capture one question now (or stop & send if capturing). */
  talk: () => void;
  /** Stop an in-progress capture and send whatever was heard. */
  stopTalking: () => void;
  /** Turn "Hey Tony" always-listening on/off. */
  toggleHandsFree: () => void;
  /** Silence an in-progress spoken reply. */
  stopSpeaking: () => void;
  dismissError: () => void;
};

// Shortest recording worth transcribing. Anything briefer (an accidental tap,
// a mic click) is near-certainly not speech — skip the API call.
const MIN_CAPTURE_MS = 300;

// Derive an OpenAI-friendly filename + MIME from the recorded blob's own type,
// so the upload matches what MediaRecorder actually produced (e.g. audio.webm /
// audio/webm) instead of a generic octet-stream that Whisper 400s on.
function audioFileMeta(blob: Blob): { filename: string; type: string } {
  const base = (blob.type || "audio/webm").split(";")[0].trim().toLowerCase();
  const ext =
    base === "audio/ogg"
      ? "ogg"
      : base === "audio/mp4"
      ? "mp4"
      : base === "audio/mpeg"
      ? "mp3"
      : base === "audio/wav" || base === "audio/x-wav"
      ? "wav"
      : "webm";
  const type = base.startsWith("audio/") ? base : "audio/webm";
  return { filename: `audio.${ext}`, type };
}

export function useTonyVoice(sharedConversation?: { current: string | null }): TonyVoice {
  const router = useRouter();
  const [state, setState] = useState<VoiceState>("idle");
  const [handsFree, setHandsFree] = useState(false);
  const [interim, setInterim] = useState("");
  const [lastTranscript, setLastTranscript] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<VoiceSupport>({ recognition: false, synthesis: false });
  const [openAiAvailable, setOpenAiAvailable] = useState(false);

  const mountedRef = useRef(true);
  const handsFreeRef = useRef(false);
  const turnActiveRef = useRef(false);
  const localConversationIdRef = useRef<string | null>(null);
  const conversationIdRef = sharedConversation ?? localConversationIdRef;

  const wakeRef = useRef<WakeController | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const browserRecogStopRef = useRef<(() => void) | null>(null);
  const cancelPlaybackRef = useRef<(() => void) | null>(null);
  // When the current Whisper capture started, so we can drop sub-0.3s blips
  // (accidental taps) instead of paying for a transcription of near-silence.
  const captureStartRef = useRef(0);

  // Sentence-by-sentence speaking queue. As Tony's reply streams in we peel off
  // complete sentences and play them back-to-back, so he starts talking almost
  // immediately instead of after the whole message. The pump drains the queue
  // one clip at a time; `streamDone` lets it settle the turn once the reply has
  // fully arrived AND the queue is empty; `cancelled` aborts it (stop/unmount).
  const speakQueueRef = useRef<string[]>([]);
  const speakPumpingRef = useRef(false);
  const streamDoneRef = useRef(false);
  const speakCancelledRef = useRef(false);

  // The capture/playback engines to use. Starts as browser (safe default) and is
  // upgraded to OpenAI once /api/voice/diag confirms the key is reachable. A
  // per-turn route failure flips the relevant engine back to browser.
  const backendRef = useRef<VoiceBackend>({ hasOpenAiKey: false, whisper: false, openAiTts: false });

  const setSafeState = useCallback((next: VoiceState) => {
    if (mountedRef.current) setState(next);
  }, []);

  // --- Mount: capability detection + backend probe --------------------------

  useEffect(() => {
    mountedRef.current = true;
    setSupport({
      recognition: speechRecognitionSupported(),
      synthesis: speechSynthesisSupported(),
    });
    primeVoices();

    // Ask the server whether OpenAI voice is configured + reachable. The key
    // itself never comes back — only booleans. Any failure → stay on browser.
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/voice/diag", { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as {
          hasOpenAiKey?: boolean;
          transcribeReachable?: boolean;
          speakReachable?: boolean;
          ttsProvider?: string | null;
        };
        if (!mountedRef.current) return;
        const whisper = Boolean(data.hasOpenAiKey && data.transcribeReachable);
        // TTS is now pluggable (Kokoro / OpenAI / ElevenLabs) and decoupled from
        // the OpenAI key — speakReachable already reflects the configured voice.
        const openAiTts = Boolean(data.speakReachable);
        backendRef.current = {
          hasOpenAiKey: Boolean(data.hasOpenAiKey),
          whisper,
          openAiTts,
        };
        setOpenAiAvailable(whisper || openAiTts);
        console.log("[voice] backend", backendRef.current);
      } catch {
        /* offline / aborted — browser fallback stays in effect */
      }
    })();

    return () => {
      mountedRef.current = false;
      controller.abort();
      speakCancelledRef.current = true;
      speakQueueRef.current = [];
      browserRecogStopRef.current?.();
      cancelPlaybackRef.current?.();
      captureRef.current?.cancel();
      wakeRef.current?.stop();
      wakeRef.current = null;
    };
  }, []);

  // --- Resting state after a turn -------------------------------------------

  // Hands-free resumes wake listening (only AFTER Tony's audio ends → guard 1),
  // otherwise we go idle.
  const settleAfterTurn = useCallback(() => {
    turnActiveRef.current = false;
    setInterim("");
    if (handsFreeRef.current && wakeRef.current) {
      wakeRef.current.resume();
      setSafeState("wake-listening");
    } else {
      setSafeState("idle");
    }
  }, [setSafeState]);

  // --- Spoken reply: sentence queue (neural TTS → browser fallback) ---------

  // Speak ONE sentence, resolving when it finishes (or is cancelled). Neural TTS
  // is requested per-sentence for low latency; any failure degrades to the
  // browser voice for this clip. A 503 flips the backend off for the rest of the
  // turn. Never rejects — the pump relies on it always settling.
  const speakSentenceOnce = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        const spoken = textForSpeech(text);
        if (!spoken || speakCancelledRef.current) {
          resolve();
          return;
        }

        const browserFallback = () => {
          const cancel = speak(spoken, {
            onEnd: () => {
              cancelPlaybackRef.current = null;
              resolve();
            },
          });
          cancelPlaybackRef.current = cancel;
          if (!cancel) resolve(); // no synthesis at all — text is already on screen
        };

        if (!backendRef.current.openAiTts) {
          browserFallback();
          return;
        }

        void (async () => {
          try {
            const res = await fetch("/api/voice/speak", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text: spoken }),
            });
            if (!res.ok) {
              if (res.status === 503) backendRef.current.openAiTts = false;
              if (!mountedRef.current) return resolve();
              browserFallback();
              return;
            }
            const blob = await res.blob();
            if (!mountedRef.current || speakCancelledRef.current) return resolve();
            const cancel = playAudioBlob(blob, {
              onEnd: () => {
                cancelPlaybackRef.current = null;
                resolve();
              },
              onError: () => {
                cancelPlaybackRef.current = null;
                if (mountedRef.current && !speakCancelledRef.current) browserFallback();
                else resolve();
              },
            });
            cancelPlaybackRef.current = cancel;
            if (!cancel) browserFallback();
          } catch (err) {
            console.warn("[voice] speak request threw — using browser TTS", err);
            if (mountedRef.current && !speakCancelledRef.current) browserFallback();
            else resolve();
          }
        })();
      }),
    []
  );

  // Drain the sentence queue one clip at a time. Only one pump runs; new
  // sentences enqueued mid-drain are picked up here. Settles the turn once the
  // reply has fully arrived (streamDone) and nothing is left to speak.
  const pumpSpeak = useCallback(async () => {
    if (speakPumpingRef.current) return;
    speakPumpingRef.current = true;
    setSafeState("speaking");
    while (speakQueueRef.current.length > 0 && !speakCancelledRef.current) {
      const next = speakQueueRef.current.shift() as string;
      await speakSentenceOnce(next);
    }
    speakPumpingRef.current = false;
    if (
      streamDoneRef.current &&
      speakQueueRef.current.length === 0 &&
      !speakCancelledRef.current
    ) {
      settleAfterTurn();
    }
  }, [speakSentenceOnce, setSafeState, settleAfterTurn]);

  const enqueueSentence = useCallback(
    (text: string) => {
      if (speakCancelledRef.current) return;
      speakQueueRef.current.push(text);
      void pumpSpeak();
    },
    [pumpSpeak]
  );

  // Speak a standalone system message (e.g. the wrong-language re-prompt) WITHOUT
  // calling Tony. Shares the speak pump so it also falls back to browser TTS and
  // settles the turn once it finishes.
  const speakNotice = useCallback(
    (message: string) => {
      setLastTranscript("");
      setLastReply(message);
      speakQueueRef.current = [];
      speakPumpingRef.current = false;
      speakCancelledRef.current = false;
      streamDoneRef.current = true;
      enqueueSentence(message);
    },
    [enqueueSentence]
  );

  // --- The turn: transcript → grounded Tony (streamed) → spoken reply --------

  const runTurn = useCallback(
    async (transcript: string) => {
      setLastTranscript(transcript);
      setLastReply("");
      setSafeState("thinking");

      // Reset the speaking queue for this turn.
      speakQueueRef.current = [];
      speakPumpingRef.current = false;
      streamDoneRef.current = false;
      speakCancelledRef.current = false;

      let acc = "";
      let sentenceBuf = "";
      let navPath: string | null = null;

      try {
        console.log("[voice] thinking: streaming from /api/assistant");
        const result = await openAssistantStream({
          conversationId: conversationIdRef.current,
          message: transcript,
        });

        if (result.kind === "json") {
          throw new Error((result.data.error as string) ?? "Tony is temporarily unavailable.");
        }

        for await (const evt of result.events) {
          if (!mountedRef.current) return;
          if (evt.type === "meta") {
            if (evt.conversationId) conversationIdRef.current = evt.conversationId;
          } else if (evt.type === "delta") {
            acc += evt.text;
            setLastReply(acc);
            // Peel off complete sentences and start speaking them immediately.
            sentenceBuf += evt.text;
            const { sentences, rest } = extractSentences(sentenceBuf);
            sentenceBuf = rest;
            for (const s of sentences) enqueueSentence(s);
          } else if (evt.type === "navigation") {
            navPath = evt.path;
          } else if (evt.type === "error") {
            throw new Error(evt.error);
          }
        }

        if (!mountedRef.current) return;

        // Navigation short-circuits speaking — the surface unmounts on the push,
        // so cancel any queued audio and go rather than talk over the transition.
        if (navPath) {
          speakCancelledRef.current = true;
          speakQueueRef.current = [];
          cancelPlaybackRef.current?.();
          cancelPlaybackRef.current = null;
          settleAfterTurn();
          router.push(navPath);
          return;
        }

        // Flush the trailing partial sentence.
        const tail = sentenceBuf.trim();
        if (tail) enqueueSentence(tail);

        if (!acc.trim()) {
          const fallback = "I wasn't able to answer that.";
          setLastReply(fallback);
          enqueueSentence(fallback);
        }

        // Reply fully arrived — let the pump settle the turn when the queue drains
        // (or settle now if there was nothing to speak).
        streamDoneRef.current = true;
        if (!speakPumpingRef.current && speakQueueRef.current.length === 0) {
          settleAfterTurn();
        } else {
          void pumpSpeak();
        }
      } catch (err) {
        if (!mountedRef.current) return;
        speakCancelledRef.current = true;
        speakQueueRef.current = [];
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setSafeState("error");
        settleAfterTurn();
      }
    },
    [enqueueSentence, pumpSpeak, router, setSafeState, settleAfterTurn]
  );

  // --- Question capture (Whisper → browser fallback) ------------------------

  // Send the recorded question to Whisper, then run the grounded turn. On any
  // route failure, degrade to browser STT for future turns and settle honestly.
  const transcribeBlob = useCallback(
    async (blob: Blob) => {
      setSafeState("transcribing");
      try {
        const { filename, type } = audioFileMeta(blob);
        const file = new File([blob], filename, { type });
        const form = new FormData();
        form.append("audio", file);
        console.log("[voice] transcribing:", file.size, "bytes →", file.type, file.name);
        const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
        if (!res.ok) {
          console.warn("[voice] transcribe route failed", res.status);
          if (res.status === 503) backendRef.current.whisper = false;
          if (!mountedRef.current) return;
          setError(
            speechRecognitionSupported()
              ? "Voice transcription is unavailable right now — using your browser's speech engine instead."
              : "Voice transcription is unavailable right now. Try again shortly."
          );
          setSafeState("error");
          settleAfterTurn();
          return;
        }
        const data = (await res.json()) as { text?: string; notice?: string };
        if (!mountedRef.current) return;
        // Wrong-language / unclear audio: speak the re-prompt, don't call Tony.
        if (data.notice) {
          speakNotice(data.notice);
          return;
        }
        const text = (data.text ?? "").trim();
        if (text) {
          void runTurn(text);
        } else {
          settleAfterTurn(); // heard nothing intelligible
        }
      } catch (err) {
        console.warn("[voice] transcribe request threw", err);
        if (!mountedRef.current) return;
        setError("Couldn't reach the transcription service. Try again shortly.");
        setSafeState("error");
        settleAfterTurn();
      }
    },
    [runTurn, setSafeState, settleAfterTurn, speakNotice]
  );

  // Browser fallback path: single-utterance Web Speech recognition → runTurn.
  const captureWithBrowser = useCallback(() => {
    if (!speechRecognitionSupported()) {
      setError("This browser can't capture speech. Try Chrome or Edge, or type your question.");
      setSafeState("error");
      turnActiveRef.current = false;
      return;
    }
    setInterim("");
    setSafeState("capturing");
    const stop = startRecognition({
      onInterim: (text) => mountedRef.current && setInterim(text),
      onError: (code) => {
        if (!mountedRef.current) return;
        if (code === "not-allowed" || code === "service-not-allowed") {
          setError("Microphone access was blocked. Allow the mic to talk to Tony.");
          setSafeState("error");
          turnActiveRef.current = false;
        }
      },
      onFinal: (text) => {
        if (!mountedRef.current) return;
        setInterim("");
        browserRecogStopRef.current = null;
        if (text) void runTurn(text);
        else settleAfterTurn();
      },
    });
    browserRecogStopRef.current = stop;
  }, [runTurn, setSafeState, settleAfterTurn]);

  // Whisper path: MediaRecorder → /api/voice/transcribe → text → runTurn. The
  // turn stays active throughout; on a capture failure we degrade to browser STT
  // for THIS turn rather than dropping it.
  const captureWithWhisper = useCallback(async () => {
    setSafeState("capturing");
    captureStartRef.current = Date.now();
    const capture = await startCapture(
      { silenceMs: 1800, maxMs: 20_000 },
      {
        onSpeechStart: () => console.log("[voice] capturing: speech detected"),
        onError: (code, message) => {
          captureRef.current = null;
          if (!mountedRef.current) return;
          if (code === "not-allowed") {
            setError("Microphone access was blocked. Allow the mic to talk to Tony.");
            setSafeState("error");
            turnActiveRef.current = false;
          } else {
            // MediaRecorder unavailable/broke — degrade to browser STT, keeping
            // the turn active so the question still gets through.
            console.warn("[voice] capture error, falling back to browser STT:", message);
            backendRef.current.whisper = false;
            captureWithBrowser();
          }
        },
        onStop: (blob) => {
          captureRef.current = null;
          if (!mountedRef.current) return;
          const elapsed = Date.now() - captureStartRef.current;
          if (!blob || elapsed < MIN_CAPTURE_MS) {
            // Nothing captured, or too brief to be real speech — skip the API.
            console.log("[voice] capture too short/empty, skipping transcribe", elapsed);
            settleAfterTurn();
            return;
          }
          void transcribeBlob(blob);
        },
      }
    );
    captureRef.current = capture;
  }, [captureWithBrowser, transcribeBlob, setSafeState, settleAfterTurn]);

  // Begin one capture turn using whichever engine is active.
  const beginCapture = useCallback(() => {
    if (turnActiveRef.current) return;
    turnActiveRef.current = true;
    setError(null);
    setInterim("");
    if (backendRef.current.whisper && mediaRecorderSupported()) {
      void captureWithWhisper();
    } else {
      captureWithBrowser();
    }
  }, [captureWithBrowser, captureWithWhisper]);

  // Fired by the in-browser wake word when "Hey Tony" is heard.
  const onWake = useCallback(() => {
    if (turnActiveRef.current) return;
    playWakeChime();
    wakeRef.current?.pause(); // guard 1: silence the wake mic for the whole turn
    beginCapture();
  }, [beginCapture]);

  // --- Public actions -------------------------------------------------------

  const talk = useCallback(() => {
    unlockAudio(); // within the click gesture, so chime/TTS may sound
    if (state === "capturing") {
      // Push-to-talk "Stop & send".
      captureRef.current?.stop();
      browserRecogStopRef.current?.();
      return;
    }
    if (turnActiveRef.current) return; // a turn is mid-flight; ignore
    wakeRef.current?.pause(); // pause hands-free during a manual turn
    beginCapture();
  }, [beginCapture, state]);

  const stopTalking = useCallback(() => {
    captureRef.current?.stop();
    browserRecogStopRef.current?.();
  }, []);

  const stopSpeaking = useCallback(() => {
    // Cancel the whole queue, not just the current clip, so the rest of the
    // streamed reply doesn't keep playing after the user hits stop.
    speakCancelledRef.current = true;
    speakQueueRef.current = [];
    cancelPlaybackRef.current?.();
    cancelPlaybackRef.current = null;
    settleAfterTurn();
  }, [settleAfterTurn]);

  // --- Hands-free ("Hey Tony") ----------------------------------------------

  const startHandsFree = useCallback(() => {
    unlockAudio();
    if (!speechRecognitionSupported()) {
      setError(
        "Hands-free “Hey Tony” needs the Web Speech API (Chrome or Edge). Push-to-talk still works here."
      );
      setSafeState("error");
      return;
    }

    const controller = startWakeWordListener({
      onWake: () => onWake(),
      onPermissionDenied: () => {
        if (!mountedRef.current) return;
        setError("Microphone access was blocked, so “Hey Tony” can't listen. Allow the mic to enable it.");
        setSafeState("error");
        void stopHandsFree();
      },
    });

    if (!controller) {
      setError("Hands-free “Hey Tony” isn't supported in this browser. Push-to-talk still works.");
      setSafeState("error");
      return;
    }

    wakeRef.current = controller;
    handsFreeRef.current = true;
    setHandsFree(true);
    setError(null);
    setSafeState("wake-listening");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWake, setSafeState]);

  const stopHandsFree = useCallback(() => {
    handsFreeRef.current = false;
    setHandsFree(false);
    wakeRef.current?.stop();
    wakeRef.current = null;
    captureRef.current?.cancel();
    captureRef.current = null;
    browserRecogStopRef.current?.();
    speakCancelledRef.current = true;
    speakQueueRef.current = [];
    cancelPlaybackRef.current?.();
    cancelPlaybackRef.current = null;
    turnActiveRef.current = false;
    setInterim("");
    if (mountedRef.current && state !== "error") setSafeState("idle");
  }, [setSafeState, state]);

  const toggleHandsFree = useCallback(() => {
    if (handsFreeRef.current) stopHandsFree();
    else startHandsFree();
  }, [startHandsFree, stopHandsFree]);

  const dismissError = useCallback(() => {
    setError(null);
    if (!mountedRef.current) return;
    if (handsFreeRef.current && wakeRef.current) {
      // Re-arm the wake mic that a mid-turn error left paused.
      wakeRef.current.resume();
      setState("wake-listening");
    } else {
      setState("idle");
    }
  }, []);

  const pushToTalkReady =
    (openAiAvailable && mediaRecorderSupported()) || support.recognition;
  const handsFreeReady = support.recognition;

  return {
    state,
    handsFree,
    interim,
    lastTranscript,
    lastReply,
    error,
    support,
    openAiAvailable,
    pushToTalkReady,
    handsFreeReady,
    talk,
    stopTalking,
    toggleHandsFree,
    stopSpeaking,
    dismissError,
  };
}

