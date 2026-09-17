import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  MAX_TRANSCRIBE_BYTES,
  TAGLISH_STT_PROMPT,
  hasNonLatinScript,
  isOpenAiConfigured,
  sttLanguage,
  transcribeAudio,
} from "@/lib/voice/openai";

// Shown (and spoken) back to the user when a transcription comes through in a
// non-Latin script — a sign Whisper heard the wrong language. We DON'T pass this
// on to Tony as a question; the client surfaces `notice` and re-prompts instead.
const UNCLEAR_NOTICE =
  "I didn't catch that clearly — please say it again in English or Taglish.";

// Best-effort: pull the caller's brand names (RLS-scoped) to prime the Whisper
// prompt so live-selling brand mentions transcribe accurately. Never throws and
// never blocks transcription — an empty string just means "no brand hints".
async function brandVocabulary(): Promise<string> {
  try {
    const supabase = createServerSupabaseClient();
    const res = await supabase.from("brands").select("name").limit(40);
    const rows = (res.data ?? []) as unknown as { name: string | null }[];
    const names = rows
      .map((b) => b?.name?.trim())
      .filter((n): n is string => Boolean(n));
    return names.length ? ` Brands: ${names.join(", ")}.` : "";
  } catch {
    return "";
  }
}

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/voice/transcribe — Whisper speech-to-text for Tony's voice.
//
// The client captures the spoken QUESTION as audio (webm/opus via MediaRecorder)
// and posts it here as multipart form-data (`audio`). We hand it to OpenAI and
// return `{ text }`, which the client then sends to the UNCHANGED grounded
// /api/assistant exactly as if it had been typed. This route only turns speech
// into text — it never sees Tony's data or brain.
//
// OPENAI_API_KEY is server-side only and never returned. When it's missing we
// answer 503 { error: "not-configured" } so the client falls back to the
// browser's Web Speech recognition instead of throwing.
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  if (!isOpenAiConfigured()) {
    console.log("[voice] transcribe: OPENAI_API_KEY not set — client should fall back");
    return NextResponse.json({ error: "not-configured" }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const file = form.get("audio");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No audio received." }, { status: 400 });
  }
  if (file.size > MAX_TRANSCRIBE_BYTES) {
    return NextResponse.json({ error: "Audio is too long." }, { status: 413 });
  }

  console.log("[voice] transcribe request", {
    user: profile.id,
    bytes: file.size,
    type: file.type,
  });

  const prompt = TAGLISH_STT_PROMPT + (await brandVocabulary());
  const { text, error } = await transcribeAudio(file, {
    language: sttLanguage(),
    prompt,
  });
  if (error) {
    return NextResponse.json(
      { error: "Transcription failed." },
      { status: error === "not-configured" ? 503 : 502 }
    );
  }

  // Script guard: if we got a non-Latin script back (Thai/CJK/Hangul/…), Whisper
  // mis-detected the language. Don't hand gibberish to Tony — tell the client to
  // re-prompt in English/Taglish.
  const clean = (text ?? "").trim();
  if (clean && hasNonLatinScript(clean)) {
    console.warn("[voice] transcribe: non-Latin script detected, re-prompting");
    return NextResponse.json({ text: "", notice: UNCLEAR_NOTICE });
  }

  return NextResponse.json({ text: clean });
}
