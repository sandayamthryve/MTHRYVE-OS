import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { normaliseMovie, getMovieStatus, type MovieResult } from "@/lib/json2video/client";
import { applyAssemblyCompletion, findAssetByProjectId } from "@/lib/json2video/complete";

// Provider payloads vary in shape, so we validate only that the body is a JSON
// object (rejecting arrays/strings/other junk) and read fields defensively.
const WebhookSchema = z.object({}).passthrough();

export const runtime = "nodejs";
// Read env (webhook secret) fresh per request; never prerender.
export const dynamic = "force-dynamic";

// POST /api/integrations/assembly/webhook — JSON2Video's completion callback. We
// register this URL as an `exports[].destinations[]` webhook when submitting, so
// JSON2Video POSTs the finished movie here. The payload carries the movie's
// { status, url, duration, project, client-data }, either flat or wrapped in a
// `movie` object — we parse both defensively. We look the project up in
// content_assets (our ledger) and finalise the row via the shared completion
// writer. This is the PREFERRED completion path; the /status poll is the fallback
// when a webhook is missed.
//
// Auth: JSON2Video POSTs to exactly the endpoint we register, so we append
// ?secret=… and compare against JSON2VIDEO_WEBHOOK_SECRET. When that env var is
// unset we accept but log a warning (fine for first-run / local), never silently
// trusting in production once you've set it. The API key is never involved here
// and never leaves the server.

function secretOk(request: NextRequest): boolean {
  const expected = process.env.JSON2VIDEO_WEBHOOK_SECRET?.trim();
  if (!expected) {
    console.warn("[json2video] webhook: JSON2VIDEO_WEBHOOK_SECRET unset — accepting unauthenticated call");
    return true;
  }
  const provided = new URL(request.url).searchParams.get("secret")?.trim();
  return provided === expected;
}

// Pull the project id from wherever JSON2Video may place it: the movie object,
// the top-level body, or the client-data we round-tripped.
function extractProjectId(body: Record<string, unknown>): string | null {
  const movie = (body.movie ?? {}) as Record<string, unknown>;
  const clientData = ((body["client-data"] ?? movie["client-data"]) ?? {}) as Record<string, unknown>;
  const candidate =
    (movie.project as string | undefined) ??
    (body.project as string | undefined) ??
    (clientData.project as string | undefined);
  return candidate && String(candidate).trim() ? String(candidate).trim() : null;
}

export async function POST(request: NextRequest) {
  if (!secretOk(request)) {
    console.error("[json2video] webhook: secret mismatch — rejecting");
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const raw = await request.json();
    const parsed = WebhookSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "invalid payload" }, { status: 400 });
    }
    body = parsed.data as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const projectId = extractProjectId(body);
  console.log("[json2video] webhook received, project", projectId);

  if (!projectId) {
    // Nothing to reconcile — ack so JSON2Video stops retrying.
    return NextResponse.json({ ok: true, ignored: "no project id" });
  }

  const row = await findAssetByProjectId(projectId);
  if (!row) {
    console.warn("[json2video] webhook: no asset row for project", projectId);
    return NextResponse.json({ ok: true, ignored: "unknown project id" });
  }

  // Already terminal → idempotent ack, no re-write.
  if (row.status === "ready" || row.status === "failed") {
    return NextResponse.json({ ok: true, already: row.status });
  }

  // Normalise the movie from the payload (flat or wrapped). If the body is thin
  // (no url / unknown status), re-fetch the authoritative status before settling.
  let result: MovieResult = normaliseMovie(body.movie ?? body);
  if (result.status === "unknown" || (result.status === "done" && !result.url)) {
    const refetched = await getMovieStatus(projectId);
    if (refetched) result = refetched;
  }

  const settled = await applyAssemblyCompletion(row, result);
  return NextResponse.json({ ok: true, settled });
}
