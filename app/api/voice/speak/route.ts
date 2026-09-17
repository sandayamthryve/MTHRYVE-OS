import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth/session";
import { parseJsonBody } from "@/lib/security/api";
import { MAX_TTS_CHARS, synthesizeSpeech, ttsConfigured } from "@/lib/voice/tts";

const SpeakSchema = z.object({
  text: z.string().max(20_000).optional(),
});

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/voice/speak — synthesize Tony's spoken reply through the configured,
// PLUGGABLE neural voice provider (see lib/voice/tts.ts: Kokoro / OpenAI /
// ElevenLabs, chosen entirely by env). To keep latency low, the client posts one
// SENTENCE at a time as Tony's answer streams in and plays each clip back-to-back
// — so Tony starts talking almost immediately instead of after the whole reply.
//
// This only changes how the answer comes OUT — the grounded answer itself is
// unchanged. No key is ever returned; when no neural provider is configured we
// answer 503 { error: "not-configured" } so the client falls back to the
// browser's free Web Speech voice (never an error, never faked audio).
export async function POST(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  if (!ttsConfigured()) {
    console.log("[voice] speak: no neural TTS provider configured — client falls back");
    return NextResponse.json({ error: "not-configured" }, { status: 503 });
  }

  const parsed = await parseJsonBody(request, SpeakSchema, "voice/speak");
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const text = (body.text ?? "").toString().trim();
  if (!text) {
    return NextResponse.json({ error: "No text to speak." }, { status: 400 });
  }

  const clamped = text.slice(0, MAX_TTS_CHARS);
  console.log("[voice] speak request", { user: profile.id, chars: clamped.length });

  const { audio, contentType, error } = await synthesizeSpeech(clamped);
  if (error || !audio) {
    return NextResponse.json(
      { error: "Speech synthesis failed." },
      { status: error === "not-configured" ? 503 : 502 }
    );
  }

  return new NextResponse(audio, {
    status: 200,
    headers: { "content-type": contentType, "cache-control": "no-store" },
  });
}
