"use client";

// Microphone capture for the spoken QUESTION → Whisper.
//
// Records mic audio with MediaRecorder (webm/opus where supported) and hands the
// finished Blob to the caller, who POSTs it to /api/voice/transcribe. Endpointing
// is automatic: a Web Audio analyser watches the level and stops after a short
// trailing silence once speech has been detected (so "Hey Tony" hands-free can
// end a question with no button), with a hard max-duration cap. Push-to-talk can
// also stop() manually at any time.
//
// This is only the CAPTURE half; the transcript then flows to the unchanged
// grounded /api/assistant. If MediaRecorder or the mic is unavailable, the caller
// falls back to the browser's Web Speech recognition.

export type CaptureErrorCode = "unsupported" | "not-allowed" | "error";

export type CaptureHandlers = {
  /** The recorded audio, or null if nothing usable was captured. */
  onStop: (blob: Blob | null) => void;
  /** Fired once when the analyser first detects the user speaking. */
  onSpeechStart?: () => void;
  onError?: (code: CaptureErrorCode, message: string) => void;
};

export type AudioCapture = {
  /** Stop and flush → onStop(blob). Used by the push-to-talk "Stop & send". */
  stop: () => void;
  /** Abort without delivering audio → onStop(null). */
  cancel: () => void;
};

export type CaptureOptions = {
  /** Trailing silence (ms) after speech that auto-stops. 0 disables auto-stop. */
  silenceMs?: number;
  /** Hard cap (ms) so a stuck capture can't run forever. */
  maxMs?: number;
};

interface AudioWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/** True when this browser can record mic audio to a Blob. */
export function mediaRecorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

// Pick the best container/codec this browser can actually record. OpenAI accepts
// webm, ogg and mp4/m4a, so any of these transcribe fine.
function pickMimeType(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return undefined;
}

/**
 * Begin recording. Resolves to an AudioCapture handle, or null if capture can't
 * start (the caller then falls back to browser speech). Errors are reported via
 * handlers.onError and never thrown.
 */
export async function startCapture(
  options: CaptureOptions,
  handlers: CaptureHandlers
): Promise<AudioCapture | null> {
  if (!mediaRecorderSupported()) {
    handlers.onError?.("unsupported", "MediaRecorder is not available.");
    return null;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    const denied = name === "NotAllowedError" || name === "SecurityError";
    handlers.onError?.(denied ? "not-allowed" : "error", name || String(err));
    return null;
  }

  const mimeType = pickMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    // Some browsers reject the options object — retry with defaults.
    try {
      recorder = new MediaRecorder(stream);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      handlers.onError?.("error", String(err));
      return null;
    }
  }

  const chunks: BlobPart[] = [];
  let stopped = false;
  let cancelled = false;

  // Silence-detection scaffolding (all optional — capture still works without it).
  let audioCtx: AudioContext | null = null;
  let rafId: number | null = null;
  let silenceTimer: number | null = null;
  let maxTimer: number | null = null;
  let speechDetected = false;

  const cleanup = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (silenceTimer !== null) window.clearTimeout(silenceTimer);
    if (maxTimer !== null) window.clearTimeout(maxTimer);
    rafId = null;
    silenceTimer = null;
    maxTimer = null;
    try {
      void audioCtx?.close();
    } catch {
      /* ignore */
    }
    stream.getTracks().forEach((t) => t.stop());
  };

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onstop = () => {
    cleanup();
    if (cancelled) {
      handlers.onStop(null);
      return;
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    handlers.onStop(blob.size > 0 ? blob : null);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      recorder.stop();
    } catch {
      cleanup();
      handlers.onStop(null);
    }
  };

  const cancel = () => {
    if (stopped) return;
    cancelled = true;
    stop();
  };

  const maxMs = options.maxMs ?? 20_000;
  maxTimer = window.setTimeout(stop, maxMs);

  const silenceMs = options.silenceMs ?? 0;
  if (silenceMs > 0) {
    try {
      const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (Ctor) {
        audioCtx = new Ctor();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const SPEECH_RMS = 0.015; // rough voice-vs-quiet threshold

        const tick = () => {
          if (stopped) return;
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);

          if (rms > SPEECH_RMS) {
            if (!speechDetected) {
              speechDetected = true;
              handlers.onSpeechStart?.();
            }
            if (silenceTimer !== null) {
              window.clearTimeout(silenceTimer);
              silenceTimer = null;
            }
          } else if (speechDetected && silenceTimer === null) {
            // Trailing silence after real speech → wrap up.
            silenceTimer = window.setTimeout(stop, silenceMs);
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      }
    } catch {
      // Level metering is a nicety; capture proceeds without auto-stop.
    }
  }

  try {
    recorder.start();
    console.log("[voice] capture started", recorder.mimeType || mimeType || "default");
  } catch (err) {
    cleanup();
    handlers.onError?.("error", String(err));
    return null;
  }

  return { stop, cancel };
}
