// OpenAI voice client — the single server-only place that talks to OpenAI for
// Tony's hands-free voice: Whisper speech-to-text and OpenAI text-to-speech.
//
// This ONLY changes how a question gets IN (spoken → text) and how the answer
// comes OUT (text → spoken). The grounded brain — /api/assistant (Claude + the
// caller's RLS-scoped data) — is untouched: transcribed text is handed to it as
// if typed, and its text reply is what we synthesize.
//
// The key is read at CALL TIME (never at module load) so Vercel "Sensitive"
// runtime-only vars are seen fresh per request and nothing captures the secret
// into a build artifact. This module runs ONLY server-side — never import it
// into a "use client" component. OPENAI_API_KEY must never reach the browser and
// is never logged. Every call degrades to a typed error string rather than
// throwing, so a route can fall the client back to browser speech cleanly.

const OPENAI_BASE = "https://api.openai.com/v1";

// Preferred model first, cheaper/older fallback second. If the account can't use
// the preferred model (400/404), we transparently retry the fallback.
const TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "whisper-1"] as const;
const SPEAK_MODELS = ["gpt-4o-mini-tts", "tts-1"] as const;

// A warm, friendly voice for Tony's replies (shared by both TTS models).
const WARM_VOICE = "coral";
const WARM_INSTRUCTIONS =
  "Speak in a warm, friendly, upbeat tone — like a helpful teammate, not a robot.";

// OpenAI hard limits we respect so a call never 413s on their side.
export const MAX_SPEAK_CHARS = 4096;
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024; // 25 MB

/** The API key, trimmed, read fresh each call. Undefined when unset. */
export function openAiKey(): string | undefined {
  const raw = process.env.OPENAI_API_KEY?.trim();
  return raw ? raw : undefined;
}

/** True only when the key is present. The UI uses this to fall back cleanly. */
export function isOpenAiConfigured(): boolean {
  return Boolean(openAiKey());
}

// --- Speech-to-text (Whisper) -----------------------------------------------

// The language we pin transcription to. Taglish is English-STRUCTURED (Tagalog
// words dropped into English sentences), so anchoring to English stops Whisper
// from auto-detecting the whole clip as Thai/Vietnamese/etc. on a few ambiguous
// phonemes. Override with VOICE_STT_LANGUAGE (an ISO-639-1 code); set it to
// "auto" to fall back to Whisper's own detection. Read fresh per call.
export function sttLanguage(): string | undefined {
  const raw = process.env.VOICE_STT_LANGUAGE?.trim();
  const lang = raw && raw.length > 0 ? raw : "en";
  return lang.toLowerCase() === "auto" ? undefined : lang;
}

// A transcription PROMPT (Whisper "initial prompt") that primes accuracy for
// Filipino English/Taglish and our commerce domain vocabulary. It biases the
// decoder toward these spellings/terms without constraining what can be heard.
// Callers may append live brand names.
export const TAGLISH_STT_PROMPT =
  "Filipino English and Taglish speech. Likely terms: GMV, ROAS, AOV, " +
  "TikTok Shop, Shopee, live selling, affiliate, creators, restock, pod.";

// Scripts that never legitimately appear in English or Taglish (both Latin).
// Covers Cyrillic, Armenian, Hebrew, Arabic, Syriac, Devanagari, Thai, Hangul,
// Japanese kana, and CJK. If any of these show up, Whisper locked onto the wrong
// language and the whole transcription is unusable — not something to hand Tony.
const NON_LATIN_SCRIPT_RE = new RegExp(
  "[" +
    "\\u0400-\\u052F" + // Cyrillic + supplement
    "\\u0530-\\u058F" + // Armenian
    "\\u0590-\\u05FF" + // Hebrew
    "\\u0600-\\u06FF" + // Arabic
    "\\u0700-\\u074F" + // Syriac
    "\\u0900-\\u097F" + // Devanagari
    "\\u0E00-\\u0E7F" + // Thai
    "\\u1100-\\u11FF" + // Hangul Jamo
    "\\u3040-\\u30FF" + // Hiragana + Katakana
    "\\u3130-\\u318F" + // Hangul Compatibility Jamo
    "\\u3400-\\u4DBF" + // CJK Extension A
    "\\u4E00-\\u9FFF" + // CJK Unified Ideographs
    "\\uA000-\\uA4CF" + // Yi
    "\\uAC00-\\uD7AF" + // Hangul Syllables
    "]"
);

/** True when the text contains a non-Latin script (Thai, CJK, Hangul, …). */
export function hasNonLatinScript(text: string): boolean {
  return NON_LATIN_SCRIPT_RE.test(text);
}

// Transcribe an uploaded audio file to text. By default the language is pinned
// (see sttLanguage) and a Taglish/domain `prompt` primes accuracy; callers pass
// { language, prompt } to override. Returns { text } on success, or { error }
// (a short reason, never the key) otherwise.
export async function transcribeAudio(
  file: File,
  opts: { language?: string; prompt?: string } = {}
): Promise<{ text: string | null; error: string | null }> {
  const key = openAiKey();
  if (!key) return { text: null, error: "not-configured" };

  let lastErr = "unknown";
  for (const model of TRANSCRIBE_MODELS) {
    try {
      const form = new FormData();
      form.append("file", file, file.name || "question.webm");
      form.append("model", model);
      // Pin language + prime with a Taglish/domain prompt to stop wrong-language
      // drift. Both are optional so callers can opt back into auto-detect.
      if (opts.language) form.append("language", opts.language);
      if (opts.prompt) form.append("prompt", opts.prompt);

      console.log("[voice] transcribe →", model, `${file.size}B`, file.type);
      const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        cache: "no-store",
      });
      const raw = await res.text();
      if (!res.ok) {
        lastErr = `openai ${res.status}`;
        console.error("[voice] transcribe failed", model, res.status, raw.slice(0, 300));
        // Model unavailable for this account → try the fallback model.
        if (res.status === 400 || res.status === 404) continue;
        return { text: null, error: lastErr };
      }
      const json = safeParse(raw) as { text?: string } | null;
      const text = (json?.text ?? "").trim();
      console.log("[voice] transcribe ok", model, `${text.length} chars`);
      return { text, error: null };
    } catch (e) {
      lastErr = "network";
      console.error("[voice] transcribe threw", model, e);
    }
  }
  return { text: null, error: lastErr };
}

// --- Text-to-speech ----------------------------------------------------------

// Synthesize `text` to an mp3. Returns the raw audio bytes on success, or
// { error } otherwise. The caller streams the bytes straight to the browser.
export async function speakText(
  text: string
): Promise<{ audio: ArrayBuffer | null; contentType: string; error: string | null }> {
  const key = openAiKey();
  if (!key) return { audio: null, contentType: "audio/mpeg", error: "not-configured" };

  const input = text.slice(0, MAX_SPEAK_CHARS);
  let lastErr = "unknown";
  for (const model of SPEAK_MODELS) {
    try {
      const body: Record<string, unknown> = {
        model,
        voice: WARM_VOICE,
        input,
        response_format: "mp3",
      };
      // Only gpt-4o-mini-tts honours free-form voice instructions.
      if (model === "gpt-4o-mini-tts") body.instructions = WARM_INSTRUCTIONS;

      console.log("[voice] speak →", model, `${input.length} chars`);
      const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (!res.ok) {
        const raw = await res.text();
        lastErr = `openai ${res.status}`;
        console.error("[voice] speak failed", model, res.status, raw.slice(0, 300));
        if (res.status === 400 || res.status === 404) continue;
        return { audio: null, contentType: "audio/mpeg", error: lastErr };
      }
      const audio = await res.arrayBuffer();
      console.log("[voice] speak ok", model, `${audio.byteLength}B`);
      return { audio, contentType: "audio/mpeg", error: null };
    } catch (e) {
      lastErr = "network";
      console.error("[voice] speak threw", model, e);
    }
  }
  return { audio: null, contentType: "audio/mpeg", error: lastErr };
}

// --- Diagnostics -------------------------------------------------------------

// Cheap, free reachability probe: GET /models/<id> verifies the key works and
// the model exists WITHOUT spending on a transcription/synthesis. Never throws.
async function modelReachable(model: string): Promise<boolean> {
  const key = openAiKey();
  if (!key) return false;
  try {
    const res = await fetch(`${OPENAI_BASE}/models/${model}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** True if either transcription model is reachable with the current key. */
export async function transcribeReachable(): Promise<boolean> {
  for (const m of TRANSCRIBE_MODELS) if (await modelReachable(m)) return true;
  return false;
}

/** True if either TTS model is reachable with the current key. */
export async function speakReachable(): Promise<boolean> {
  for (const m of SPEAK_MODELS) if (await modelReachable(m)) return true;
  return false;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
