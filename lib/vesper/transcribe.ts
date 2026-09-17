// Vesper Studio — in-runtime TRANSCRIPTION for a Cloudinary-hosted replay.
//
// Phase 2 adds a serverless transcription path that the worker's ffmpeg one
// does NOT replace: when the source replay already lives on Cloudinary (the
// Phase 1 signed direct-upload path), Cloudinary itself can deliver a small,
// mono, downsampled MP3 of the video's audio track via a URL transformation —
// so the Vercel runtime never needs ffmpeg to get transcribable audio. We fetch
// that derived audio URL and hand the bytes to OpenAI Whisper (verbose_json, so
// we get per-segment timestamps), pinned to English to keep Taglish (English-
// structured Filipino) from drifting to the wrong language.
//
// SERVICE ATTRIBUTION (honest, per the brief): transcription here is OpenAI
// Whisper (whisper-1) — the SAME provider the out-of-runtime worker uses; this
// module just reaches it without ffmpeg by leaning on Cloudinary for the audio
// extraction. Segment SELECTION stays Anthropic (lib/vesper/segment.ts).
//
// This is a pure server util: it never throws for a fetch/API error — it returns
// { transcript: null, error } so the route can mark the job 'failed' honestly.
// Must never be imported into a "use client" component (reads OPENAI_API_KEY).

import type { Transcript, TranscriptCue } from "@/lib/vesper/types";
import {
  MAX_TRANSCRIBE_BYTES,
  TAGLISH_STT_PROMPT,
  openAiKey,
  sttLanguage,
} from "@/lib/voice/openai";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
// whisper-1 is the model that returns verbose_json with segment timestamps; the
// newer gpt-4o-transcribe models do not expose per-segment times, which we need
// to place the highlight windows. Mirrors the worker's choice.
const WHISPER_MODEL = "whisper-1";

// The result of a transcription attempt. `minutes`/`bytes` are cost breadcrumbs
// the caller logs BEFORE any scaling decision (see the brief's cost guardrail).
export interface TranscribeResult {
  transcript: Transcript | null;
  service: string;
  error: string | null;
  minutes: number | null;
  bytes: number | null;
}

// True for a Cloudinary delivery URL we can rewrite into an audio delivery.
// Cloudinary video URLs look like:
//   https://res.cloudinary.com/<cloud>/video/upload/<transforms?>/v123/<public_id>.<ext>
function isCloudinaryVideoUrl(url: URL): boolean {
  return (
    /(^|\.)res\.cloudinary\.com$/.test(url.hostname) &&
    url.pathname.includes("/video/upload/")
  );
}

// Derive a small, Whisper-friendly AUDIO URL from a Cloudinary VIDEO url:
//   • insert an audio transformation right after `/video/upload/`
//       ac_mono   — 1 channel (halves the bytes; speech is mono anyway)
//       af_16000  — 16 kHz sample rate (Whisper downsamples to this regardless)
//       q_auto:low — let Cloudinary pick a low-but-usable bitrate
//   • swap the file extension to .mp3 so Cloudinary extracts + encodes the audio.
// Non-Cloudinary URLs are returned unchanged (best effort — Whisper accepts many
// container formats directly; oversized ones are caught by the byte guard below).
export function deriveAudioUrl(sourceUrl: string): string {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return sourceUrl;
  }
  if (!isCloudinaryVideoUrl(url)) return sourceUrl;

  const marker = "/video/upload/";
  const idx = url.pathname.indexOf(marker);
  const head = url.pathname.slice(0, idx + marker.length);
  const tail = url.pathname.slice(idx + marker.length);
  // Swap the extension (or append) to .mp3 so the delivery is an audio file.
  const mp3Tail = tail.replace(/\.[a-z0-9]+$/i, "") + ".mp3";
  url.pathname = `${head}ac_mono,af_16000,q_auto:low/${mp3Tail}`;
  return url.toString();
}

// Fetch the (derived) audio for a source URL and transcribe it with Whisper.
// Returns a Transcript with timestamped cues, or { transcript: null, error }.
export async function transcribeFromUrl(
  sourceUrl: string,
  opts: { language?: string } = {}
): Promise<TranscribeResult> {
  const service = "openai-whisper";
  const key = openAiKey();
  if (!key) return { transcript: null, service, error: "not-configured", minutes: null, bytes: null };

  const audioUrl = deriveAudioUrl(sourceUrl);
  const language = opts.language ?? sttLanguage();

  let bytes: number | null = null;
  try {
    // 1) Pull the audio bytes (Cloudinary extracts + encodes the mp3 for us).
    const audioRes = await fetch(audioUrl, { cache: "no-store" });
    if (!audioRes.ok) {
      return { transcript: null, service, error: `source ${audioRes.status}`, minutes: null, bytes: null };
    }
    const buf = await audioRes.arrayBuffer();
    bytes = buf.byteLength;
    if (bytes === 0) {
      return { transcript: null, service, error: "empty-audio", minutes: null, bytes };
    }
    // Whisper hard-caps uploads at 25 MB. A mono 16 kHz low-q mp3 is ~0.5 MB/min,
    // so this covers ~45-min replays; a longer one fails HONESTLY (never silently
    // truncates) so we scale it in the worker instead. See the cost guardrail.
    if (bytes > MAX_TRANSCRIBE_BYTES) {
      return { transcript: null, service, error: "audio-too-large", minutes: null, bytes };
    }

    // 2) Whisper, verbose_json → per-segment timestamps. English-pinned + a
    //    Taglish/commerce prompt so brand names + live-selling terms land right.
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "audio/mpeg" }), "replay.mp3");
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "verbose_json");
    if (language) form.append("language", language);
    form.append("prompt", TAGLISH_STT_PROMPT);

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      console.error("[vesper/transcribe] whisper failed", res.status, detail);
      return { transcript: null, service, error: `whisper ${res.status}`, minutes: null, bytes };
    }

    const json = (await res.json()) as {
      language?: string;
      duration?: number;
      segments?: { start?: number; end?: number; text?: string }[];
    };
    const cues: TranscriptCue[] = [];
    for (const seg of json.segments ?? []) {
      const text = (seg.text ?? "").trim();
      if (!text) continue;
      cues.push({ start: Number(seg.start) || 0, end: Number(seg.end) || 0, text });
    }
    if (cues.length === 0) {
      return { transcript: null, service, error: "empty-transcript", minutes: null, bytes };
    }

    const duration =
      Number.isFinite(json.duration) && (json.duration as number) > 0
        ? (json.duration as number)
        : cues[cues.length - 1].end;
    const minutes = duration ? Math.round((duration / 60) * 100) / 100 : null;

    const transcript: Transcript = {
      service,
      language: json.language ?? language ?? null,
      cues,
      duration_seconds: duration ?? null,
    };
    return { transcript, service, error: null, minutes, bytes };
  } catch (e) {
    console.error("[vesper/transcribe] threw", e);
    return { transcript: null, service, error: "network", minutes: null, bytes };
  }
}
