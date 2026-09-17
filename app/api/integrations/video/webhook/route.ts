import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { normaliseFalStatus, normaliseFalResult, getQueueResult, type FalVideoResult } from "@/lib/fal/client";
import { applyFalCompletion, findAssetByRequestId } from "@/lib/fal/complete";

// Provider payloads vary in shape; validate only that the body is a JSON object.
const WebhookSchema = z.object({}).passthrough();

export const runtime = "nodejs";
// Read env (webhook secret) fresh per request; never prerender.
export const dynamic = "force-dynamic";

// POST /api/integrations/video/webhook — fal's completion callback. We pass this
// URL as ?fal_webhook=<url> when submitting, so fal POSTs the finished job here:
//   { request_id, gateway_request_id, status: 'OK' | 'ERROR', payload, error }
// We look request_id up in content_assets (our ledger) and finalise the row via
// the shared completion writer. This is the PREFERRED completion path; the
// /status poll route is the fallback when a webhook is missed.
//
// Auth: fal lets you register an arbitrary webhook URL, so we gate on a shared
// secret carried as ?secret=… and compared against FAL_WEBHOOK_SECRET. When that
// env var is unset we accept but log a warning (fine for first-run / local),
// never silently trusting in production once you've set it. The FAL_KEY is never
// involved here and never leaves the server.

function secretOk(request: NextRequest): boolean {
  const expected = process.env.FAL_WEBHOOK_SECRET?.trim();
  if (!expected) {
    console.warn("[fal] webhook: FAL_WEBHOOK_SECRET unset — accepting unauthenticated call");
    return true;
  }
  const provided = new URL(request.url).searchParams.get("secret")?.trim();
  return provided === expected;
}

interface FalWebhookBody {
  request_id?: string;
  gateway_request_id?: string;
  status?: string; // "OK" | "ERROR"
  payload?: unknown;
  error?: string | { message?: string } | null;
}

export async function POST(request: NextRequest) {
  if (!secretOk(request)) {
    console.error("[fal] webhook: secret mismatch — rejecting");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: FalWebhookBody;
  try {
    const raw = await request.json();
    const parsed = WebhookSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    body = parsed.data as FalWebhookBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const requestId = body.request_id ?? body.gateway_request_id;
  const status = normaliseFalStatus(body.status);
  console.log("[fal] webhook received", body.status, "request_id", requestId);

  if (!requestId) {
    // Nothing to reconcile — ack so fal stops retrying.
    return NextResponse.json({ ok: true, ignored: "no request_id" });
  }

  const row = await findAssetByRequestId(requestId);
  if (!row) {
    console.warn("[fal] webhook: no asset row for request", requestId);
    return NextResponse.json({ ok: true, ignored: "unknown request_id" });
  }

  // Already terminal → idempotent ack, no re-write.
  if (row.status === "ready" || row.status === "failed") {
    return NextResponse.json({ ok: true, already: row.status });
  }

  // On error, settle failed. On OK, the webhook body carries the model output in
  // `payload`; normalise it. If that payload is thin (no url), re-fetch the
  // authoritative result before giving up.
  let result: FalVideoResult;
  if (status === "failed") {
    const err =
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ?? "fal reported the render failed.");
    result = { status: "failed", videoUrl: null, thumbnailUrl: null, durationSeconds: null, error: err };
  } else {
    result = normaliseFalResult(body.payload);
    if (!result.videoUrl && row.fal_slug) {
      const refetched = await getQueueResult(row.fal_slug, requestId, row.fal_response_url);
      if (refetched) result = refetched;
    }
  }

  const settled = await applyFalCompletion(row, result);
  return NextResponse.json({ ok: true, settled });
}
