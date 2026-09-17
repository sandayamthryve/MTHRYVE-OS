import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { isOpenAiConfigured, transcribeReachable } from "@/lib/voice/openai";
import { ttsConfigured, ttsProviderName } from "@/lib/voice/tts";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/voice/diag — self-diagnostics for Tony's voice, WITHOUT leaking any
// key: booleans (and the provider NAME) only.
//
//   { hasOpenAiKey, transcribeReachable, speakReachable, ttsProvider }
//
// hasOpenAiKey reflects OPENAI_API_KEY presence (read at call time) and gates the
// Whisper speech-to-text path. transcribeReachable does a cheap, free GET
// /models/<id> probe to confirm the key works. speakReachable is now provider-
// AGNOSTIC: true whenever a pluggable neural voice (Kokoro / OpenAI / ElevenLabs)
// is configured — independent of the OpenAI key — so a self-hosted Kokoro voice
// lights up even with no OpenAI account. ttsProvider names the active voice for
// the UI. No key is ever returned; any probe failure degrades to false.
export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const hasOpenAiKey = isOpenAiConfigured();
  const transcribe = hasOpenAiKey ? await transcribeReachable() : false;

  return NextResponse.json({
    hasOpenAiKey,
    transcribeReachable: transcribe,
    speakReachable: ttsConfigured(),
    ttsProvider: ttsProviderName(),
  });
}
