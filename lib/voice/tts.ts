// Pluggable text-to-speech for Tony's spoken reply.
//
// The whole point: swap Tony's voice WITHOUT a code change. The provider is
// chosen entirely by env, and if nothing neural is configured we say so and the
// client falls back to the browser's free Web Speech voice — we NEVER error and
// NEVER fake audio. This module is server-only (never import into a "use client"
// file); keys are read at call time so Vercel "Sensitive" runtime vars are seen
// fresh and nothing is captured into a build artifact, and no key is ever logged
// or returned to the browser.
//
// Providers (set TTS_PROVIDER):
//   • kokoro      — a self-hosted, OpenAI-compatible endpoint (/v1/audio/speech).
//                   Free to run, no per-word cost. Requires TTS_ENDPOINT.
//   • openai      — OpenAI TTS (api.openai.com or a compatible TTS_ENDPOINT).
//   • elevenlabs  — ElevenLabs text-to-speech.
//
// Backwards-compatible default: if TTS_PROVIDER is unset but OPENAI_API_KEY is
// present, we behave exactly as before (OpenAI TTS), so existing deployments
// keep their voice with no new config. With neither, TTS is "not-configured".
//
// Env keys (all optional except where noted per provider):
//   TTS_PROVIDER   kokoro | openai | elevenlabs
//   TTS_ENDPOINT   base URL or full speech endpoint (required for kokoro)
//   TTS_API_KEY    provider key/token (optional for a keyless self-hosted Kokoro)
//   TTS_VOICE      voice id/name (provider default otherwise)
//   TTS_MODEL      model id (provider default otherwise)

import { openAiKey } from "./openai";

export const MAX_TTS_CHARS = 4096;

export type TtsProviderName = "kokoro" | "openai" | "elevenlabs";

export type TtsConfig = {
  provider: TtsProviderName;
  endpoint: string; // fully-resolved speech endpoint
  apiKey: string | undefined;
  voice: string;
  model: string;
};

function env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function normalizeProvider(v: string | undefined): TtsProviderName | null {
  const p = v?.toLowerCase();
  if (p === "kokoro" || p === "openai" || p === "elevenlabs") return p;
  return null;
}

// Join a base URL with a path, tolerating a base that already includes the path
// (so TTS_ENDPOINT can be either "https://host" or "https://host/v1/audio/speech").
function withPath(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith(path)) return trimmed;
  // If the caller gave a full-looking endpoint (ends in /speech or similar), keep it.
  if (/\/(speech|audio\/speech|text-to-speech)(\/[^/]+)?$/.test(trimmed)) return trimmed;
  return `${trimmed}${path}`;
}

/**
 * Resolve the active TTS provider from env, or null when nothing neural is
 * configured (the client then uses the browser voice). Read fresh each call.
 */
export function resolveTtsConfig(): TtsConfig | null {
  const explicit = normalizeProvider(env("TTS_PROVIDER"));
  const ttsKey = env("TTS_API_KEY");
  const voice = env("TTS_VOICE");
  const model = env("TTS_MODEL");
  const endpoint = env("TTS_ENDPOINT");

  // Explicit provider selection.
  if (explicit === "kokoro") {
    // Self-hosted — an endpoint is mandatory; without it, degrade to browser.
    if (!endpoint) return null;
    return {
      provider: "kokoro",
      endpoint: withPath(endpoint, "/v1/audio/speech"),
      apiKey: ttsKey, // often keyless
      voice: voice ?? "af_heart",
      model: model ?? "kokoro",
    };
  }

  if (explicit === "openai") {
    const key = ttsKey ?? openAiKey();
    if (!key) return null;
    return {
      provider: "openai",
      endpoint: withPath(endpoint ?? "https://api.openai.com", "/v1/audio/speech"),
      apiKey: key,
      voice: voice ?? "coral",
      model: model ?? "gpt-4o-mini-tts",
    };
  }

  if (explicit === "elevenlabs") {
    const key = ttsKey;
    if (!key) return null;
    const base = endpoint ?? "https://api.elevenlabs.io";
    const v = voice ?? "21m00Tcm4TlvDq8ikWAM"; // "Rachel" — ElevenLabs default
    return {
      provider: "elevenlabs",
      endpoint: withPath(base, `/v1/text-to-speech/${v}`),
      apiKey: key,
      voice: v,
      model: model ?? "eleven_turbo_v2_5",
    };
  }

  // No explicit provider — keep the old behaviour when OPENAI_API_KEY is set.
  const legacyKey = openAiKey();
  if (legacyKey) {
    return {
      provider: "openai",
      endpoint: "https://api.openai.com/v1/audio/speech",
      apiKey: legacyKey,
      voice: voice ?? "coral",
      model: model ?? "gpt-4o-mini-tts",
    };
  }

  return null;
}

/** True when a neural voice is configured (client uses this to decide fallback). */
export function ttsConfigured(): boolean {
  return resolveTtsConfig() !== null;
}

/** The active provider name, or null — surfaced by /api/voice/diag for the UI. */
export function ttsProviderName(): TtsProviderName | null {
  return resolveTtsConfig()?.provider ?? null;
}

const OPENAI_COMPAT_INSTRUCTIONS =
  "Speak crisp, warm, and confident — a fast, futuristic chief of staff. Natural, never robotic.";

/**
 * Synthesize `text` to audio bytes using the configured provider. Returns
 * { audio } on success or a typed { error }; never throws. "not-configured"
 * tells the caller to fall back to the browser voice.
 */
export async function synthesizeSpeech(
  text: string
): Promise<{ audio: ArrayBuffer | null; contentType: string; error: string | null }> {
  const cfg = resolveTtsConfig();
  if (!cfg) return { audio: null, contentType: "audio/mpeg", error: "not-configured" };

  const input = text.slice(0, MAX_TTS_CHARS);
  try {
    if (cfg.provider === "elevenlabs") {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "audio/mpeg",
          ...(cfg.apiKey ? { "xi-api-key": cfg.apiKey } : {}),
        },
        body: JSON.stringify({
          text: input,
          model_id: cfg.model,
          output_format: "mp3_44100_128",
        }),
        cache: "no-store",
      });
      if (!res.ok) {
        const raw = await res.text();
        console.error("[voice] tts elevenlabs failed", res.status, raw.slice(0, 200));
        return { audio: null, contentType: "audio/mpeg", error: `provider ${res.status}` };
      }
      return { audio: await res.arrayBuffer(), contentType: "audio/mpeg", error: null };
    }

    // kokoro + openai share the OpenAI-compatible /v1/audio/speech shape.
    const bodyObj: Record<string, unknown> = {
      model: cfg.model,
      voice: cfg.voice,
      input,
      response_format: "mp3",
    };
    // Only OpenAI's gpt-4o-mini-tts honours free-form voice instructions; harmless
    // to Kokoro (ignored), so we only send it for that specific OpenAI model.
    if (cfg.provider === "openai" && cfg.model === "gpt-4o-mini-tts") {
      bodyObj.instructions = OPENAI_COMPAT_INSTRUCTIONS;
    }

    console.log("[voice] tts →", cfg.provider, cfg.model, `${input.length} chars`);
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(bodyObj),
      cache: "no-store",
    });
    if (!res.ok) {
      const raw = await res.text();
      console.error("[voice] tts failed", cfg.provider, res.status, raw.slice(0, 200));
      return { audio: null, contentType: "audio/mpeg", error: `provider ${res.status}` };
    }
    const audio = await res.arrayBuffer();
    console.log("[voice] tts ok", cfg.provider, `${audio.byteLength}B`);
    return { audio, contentType: "audio/mpeg", error: null };
  } catch (e) {
    console.error("[voice] tts threw", cfg.provider, e);
    return { audio: null, contentType: "audio/mpeg", error: "network" };
  }
}
