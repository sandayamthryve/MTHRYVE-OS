import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth/session";
import { isOpenAiConfigured } from "@/lib/voice/openai";
import { isCloudinaryConfigured } from "@/lib/cloudinary/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/vesper/diag — is the auto-clipping pipeline wired up? Reports which
// services are configured, WITHOUT spending on any of them. ffmpeg is
// deliberately NOT probed here: it never runs in this serverless runtime (see
// docs/VESPER_STUDIO.md) — clipping happens in the out-of-runtime worker.
export async function GET() {
  await requireProfile();
  return NextResponse.json({
    ok: true,
    // Segment selection (Anthropic) — runs in-app.
    hasAnthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    // Transcription (OpenAI Whisper). Phase 2 runs it IN-APP for Cloudinary
    // replays (Cloudinary delivers the audio, no ffmpeg — see the transcribe
    // route); the worker still handles raw-asset / oversized sources.
    hasOpenAI: isOpenAiConfigured(),
    // Storage service role — the worker needs this to read the source and write
    // clips + drafts back (it has no user session).
    hasServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
    // Cloudinary — powers the Phase 1 signed direct replay upload (browser →
    // Cloudinary). The API secret is used only to sign, server-side.
    hasCloudinary: isCloudinaryConfigured(),
    // Honest note on where the heavy lifting happens.
    videoProcessing: "out-of-runtime-worker",
    note:
      "ffmpeg + long-audio transcription run in worker/vesper-clipper.mjs, not in the Vercel runtime. See docs/VESPER_STUDIO.md.",
  });
}
