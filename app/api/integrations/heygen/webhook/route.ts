import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getVideoStatus, normaliseStatus } from "@/lib/heygen/client";
import { applyHeygenCompletion, findGenerationByVideoId } from "@/lib/heygen/complete";

// Provider payloads vary in shape; validate only that the body is a JSON object.
const WebhookSchema = z.object({}).passthrough();

export const runtime = "nodejs";
// Read env (webhook secret) fresh per request; never prerender.
export const dynamic = "force-dynamic";

// POST /api/integrations/heygen/webhook — HeyGen's completion callback. Register
// this URL in the HeyGen dashboard (Webhooks) for the avatar_video.success and
// avatar_video.fail events. HeyGen posts { event_type, event_data: { video_id,
// url, ... } }; we look the video_id up in our ledger and finalise the row via
// the shared completion writer (which also mirrors the URL onto the content
// item). This is the PREFERRED completion path; the /status poll route is the
// fallback when a webhook can't be registered or is missed.
//
// Auth: HeyGen lets you register an arbitrary URL, so we gate on a shared secret
// carried as ?secret=… and compared against HEYGEN_WEBHOOK_SECRET. When that env
// var is unset we accept but log a warning (fine for first-run / local), never
// silently trusting in production if you've set the secret. The API key is never
// involved here and never leaves the server.

function secretOk(request: NextRequest): boolean {
  const expected = process.env.HEYGEN_WEBHOOK_SECRET?.trim();
  if (!expected) {
    console.warn("[heygen] webhook: HEYGEN_WEBHOOK_SECRET unset — accepting unauthenticated call");
    return true;
  }
  const provided = new URL(request.url).searchParams.get("secret")?.trim();
  return provided === expected;
}

interface HeygenWebhookBody {
  event_type?: string;
  event_data?: {
    video_id?: string;
    url?: string | null;
    thumbnail_url?: string | null;
    gif_download_url?: string | null;
    duration?: number | string | null;
    msg?: string | null;
    error?: { message?: string; detail?: string } | string | null;
  };
}

export async function POST(request: NextRequest) {
  if (!secretOk(request)) {
    console.error("[heygen] webhook: secret mismatch — rejecting");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: HeygenWebhookBody;
  try {
    const raw = await request.json();
    const parsed = WebhookSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    body = parsed.data as HeygenWebhookBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const eventType = body.event_type ?? "";
  const videoId = body.event_data?.video_id;
  console.log("[heygen] webhook received", eventType, "video_id", videoId);

  if (!videoId) {
    // Some HeyGen events (e.g. account-level) carry no video_id — ack so HeyGen
    // stops retrying, but there's nothing to reconcile.
    return NextResponse.json({ ok: true, ignored: "no video_id" });
  }

  const row = await findGenerationByVideoId(videoId);
  if (!row) {
    console.warn("[heygen] webhook: no ledger row for video", videoId);
    return NextResponse.json({ ok: true, ignored: "unknown video_id" });
  }

  // Already terminal → idempotent ack, no re-write.
  if (row.status === "completed" || row.status === "failed") {
    return NextResponse.json({ ok: true, already: row.status });
  }

  const isFail = eventType.includes("fail") || eventType.includes("error");

  // On success, re-fetch the authoritative status so we get duration + thumbnail
  // even if the event payload is thin. If that call fails, fall back to whatever
  // the event itself carried.
  let status = isFail
    ? normaliseStatus({ status: "failed", error: body.event_data?.msg ?? body.event_data?.error })
    : await getVideoStatus(videoId);

  if (!status) {
    status = normaliseStatus({
      status: "completed",
      video_url: body.event_data?.url ?? null,
      thumbnail_url: body.event_data?.thumbnail_url ?? null,
      duration: body.event_data?.duration ?? null,
    });
  }

  const settled = await applyHeygenCompletion(row, status);
  return NextResponse.json({ ok: true, settled });
}
