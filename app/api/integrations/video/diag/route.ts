import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { isFalConfigured } from "@/lib/fal/client";
import { sampleModelsCount } from "@/lib/fal/models";

export const runtime = "nodejs";
// Read env fresh on every request (Vercel "Sensitive" runtime-only vars).
export const dynamic = "force-dynamic";

// GET /api/integrations/video/diag — leadership-only self-diagnostics for the
// fal.ai generative-video integration. Answers "is the key set and does the
// model catalog load?" WITHOUT ever leaking the key: booleans + counts only.
//
//   { hasKey, sampleModelsCount, hasWebhookSecret, runtime, dynamic }
//
// hasKey reflects FAL_KEY presence (read at call time). sampleModelsCount is the
// number of models the picker exposes — a cheap "catalog loaded" signal. The key
// itself is NEVER returned. Gated by the same leadership requireRole as the rest
// of the integration.
export async function GET() {
  await requireRole(["ceo", "coo", "department_head"]);

  return NextResponse.json({
    hasKey: isFalConfigured(),
    sampleModelsCount: sampleModelsCount(),
    hasWebhookSecret: Boolean(process.env.FAL_WEBHOOK_SECRET),
    runtime: "nodejs",
    dynamic: true,
  });
}
