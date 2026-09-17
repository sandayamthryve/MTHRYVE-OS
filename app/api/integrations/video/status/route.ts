import { NextRequest, NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isFalConfigured, getQueueStatus, getQueueResult } from "@/lib/fal/client";
import { applyFalCompletion, type FalAssetRow } from "@/lib/fal/complete";

export const runtime = "nodejs";
// Read env fresh per request (FAL_KEY is runtime-only).
export const dynamic = "force-dynamic";

// GET /api/integrations/video/status — the FALLBACK completion path (the webhook
// is preferred). Polls fal for the caller's in-flight video assets (provider
// 'fal', status 'processing') and finalises any that finished/failed via the
// shared completion writer.
//
//   ?id=<asset_id>        → poll just that one row (still org-scoped by RLS)
//   ?redirect=/some/path  → after polling, 302 back there (for a plain link in
//                           the UI); otherwise returns a JSON summary.
//
// Any authed org member may refresh (the read goes through the RLS user client,
// which scopes rows to their org); the completion WRITE is service-role inside
// applyFalCompletion. The fal key never reaches the browser.

// Loosely-typed, chainable+awaitable read shim for content_assets (not in the
// generated types). Every filter returns the same builder, which is itself a
// PromiseLike so it can be awaited at any point in the chain.
type AssetQuery = {
  eq: (c: string, v: string) => AssetQuery;
} & PromiseLike<{ data: unknown[] | null; error: unknown }>;
type ReadDb = { from: (t: string) => { select: (c: string) => AssetQuery } };

export async function GET(request: NextRequest) {
  const profile = await requireProfile();
  const url = new URL(request.url);
  const onlyId = url.searchParams.get("id")?.trim() || null;
  const redirectTo = url.searchParams.get("redirect")?.trim() || null;

  const done = (payload: Record<string, unknown>) => {
    // Only ever redirect to a same-app relative path.
    if (redirectTo && redirectTo.startsWith("/") && !redirectTo.startsWith("//")) {
      return NextResponse.redirect(new URL(redirectTo, url.origin));
    }
    return NextResponse.json(payload);
  };

  if (!isFalConfigured()) {
    return done({ ok: false, error: "not_configured", polled: 0, settled: [] });
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as ReadDb;
  const COLS = "id, content_item_id, status, cost_usd, meta";

  // In-flight = provider 'fal', status 'processing'. RLS scopes to the caller's
  // org; we filter to a single id when asked (still org-scoped by RLS).
  let query = db
    .from("content_assets")
    .select(COLS)
    .eq("provider", "fal")
    .eq("status", "processing");
  if (onlyId) query = query.eq("id", onlyId);
  const { data, error } = await query;

  if (error) {
    console.error("[fal] status poll: read failed", error);
    return done({ ok: false, error: "read_failed", polled: 0, settled: [] });
  }

  const rows = ((data ?? []) as unknown as Array<{
    id: string;
    content_item_id: string | null;
    status: string;
    cost_usd: number | string | null;
    meta: Record<string, unknown> | null;
  }>).filter((r) => r.meta && r.meta.fal_request_id);
  console.log("[fal] status poll: org", profile.org_id, "in-flight", rows.length);

  const settled: Array<{ id: string; status: string }> = [];
  for (const r of rows) {
    const meta = r.meta ?? {};
    const requestId = String(meta.fal_request_id);
    const slug = (meta.fal_slug as string | undefined) ?? "";
    const statusUrl = (meta.fal_status_url as string | undefined) ?? null;
    const responseUrl = (meta.fal_response_url as string | undefined) ?? null;
    if (!slug) continue;

    const st = await getQueueStatus(slug, requestId, statusUrl);
    if (!st) continue; // transient — leave the row for the next poll
    if (st.status !== "completed" && st.status !== "failed") continue; // still rendering

    // Terminal in the queue → fetch the authoritative result and settle the row.
    const result =
      st.status === "failed"
        ? { status: "failed" as const, videoUrl: null, thumbnailUrl: null, durationSeconds: null, error: "fal reported the render failed." }
        : await getQueueResult(slug, requestId, responseUrl);
    if (!result) continue;

    const assetRow: FalAssetRow = {
      id: r.id,
      content_item_id: r.content_item_id,
      status: r.status,
      estimated_cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
      fal_model_id: (meta.fal_model_id as string | undefined) ?? null,
    };

    const outcome = await applyFalCompletion(assetRow, result);
    if (outcome === "ready" || outcome === "failed") settled.push({ id: r.id, status: outcome });
  }

  return done({ ok: true, polled: rows.length, settled });
}
