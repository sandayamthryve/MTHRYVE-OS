import { NextRequest, NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isJson2VideoConfigured, getMovieStatus } from "@/lib/json2video/client";
import { applyAssemblyCompletion, ledgerRowFromRead } from "@/lib/json2video/complete";

export const runtime = "nodejs";
// Read env fresh per request (JSON2VIDEO_API_KEY is runtime-only).
export const dynamic = "force-dynamic";

// GET /api/integrations/assembly/status — the FALLBACK completion path (the
// webhook is preferred). Polls JSON2Video for the caller's in-flight assembled
// videos (provider 'json2video', status 'processing') and finalises any that
// finished/failed via the shared completion writer.
//
//   ?id=<asset_id>        → poll just that one row (still org-scoped by RLS)
//   ?redirect=/some/path  → after polling, 302 back there (for a plain link in
//                           the UI); otherwise returns a JSON summary.
//
// Any authed org member may refresh (the read goes through the RLS user client,
// which scopes rows to their org); the completion WRITE is service-role inside
// applyAssemblyCompletion. The JSON2Video key never reaches the browser.

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

  if (!isJson2VideoConfigured()) {
    return done({ ok: false, error: "not_configured", polled: 0, settled: [] });
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as ReadDb;
  const COLS = "id, content_item_id, status, cost_usd, meta";

  // In-flight = provider 'json2video', status 'processing'. RLS scopes to the
  // caller's org; we filter to a single id when asked (still org-scoped by RLS).
  let query = db
    .from("content_assets")
    .select(COLS)
    .eq("provider", "json2video")
    .eq("status", "processing");
  if (onlyId) query = query.eq("id", onlyId);
  const { data, error } = await query;

  if (error) {
    console.error("[json2video] status poll: read failed", error);
    return done({ ok: false, error: "read_failed", polled: 0, settled: [] });
  }

  const rows = ((data ?? []) as unknown as Array<{
    id: string;
    content_item_id: string | null;
    status: string;
    cost_usd: number | string | null;
    meta: Record<string, unknown> | null;
  }>).filter((r) => r.meta && r.meta.json2video_project);
  console.log("[json2video] status poll: org", profile.org_id, "in-flight", rows.length);

  const settled: Array<{ id: string; status: string }> = [];
  for (const r of rows) {
    const ledger = ledgerRowFromRead(r);
    if (!ledger.project_id) continue;

    const result = await getMovieStatus(ledger.project_id);
    if (!result) continue; // transient — leave the row for the next poll
    if (result.status !== "done" && result.status !== "failed") continue; // still rendering

    const outcome = await applyAssemblyCompletion(ledger, result);
    if (outcome === "ready" || outcome === "failed") settled.push({ id: r.id, status: outcome });
  }

  return done({ ok: true, polled: rows.length, settled });
}
