import { NextRequest, NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getVideoStatus, isHeygenConfigured } from "@/lib/heygen/client";
import { applyHeygenCompletion, type HeygenGenerationRow } from "@/lib/heygen/complete";

export const runtime = "nodejs";
// Read env fresh per request (HEYGEN_API_KEY is runtime-only).
export const dynamic = "force-dynamic";

// GET /api/integrations/heygen/status — the FALLBACK completion path (the webhook
// is preferred). Polls HeyGen for the caller's in-flight generations and
// finalises any that finished/failed via the shared completion writer.
//
//   ?id=<generation_id>   → poll just that one row (still org-scoped by RLS)
//   ?redirect=/some/path  → after polling, 302 back there (for a plain link in
//                           the UI); otherwise returns a JSON summary.
//
// Any authed org member may refresh (read via the RLS user client, which scopes
// rows to their org); the completion write itself is service-role inside
// applyHeygenCompletion. The API key never reaches the browser.

// Loosely-typed read shim — heygen_generations isn't in the generated types.
type ReadDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => {
        in: (c: string, v: string[]) => Promise<{ data: unknown[] | null; error: unknown }>;
      };
      in: (c: string, v: string[]) => Promise<{ data: unknown[] | null; error: unknown }>;
    };
  };
};

type InFlightRow = HeygenGenerationRow & { heygen_video_id: string | null };

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

  if (!isHeygenConfigured()) {
    return done({ ok: false, error: "not_configured", polled: 0, settled: [] });
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as ReadDb;
  const COLS = "id, content_item_id, script, estimated_cost_usd, status, heygen_video_id";

  // In-flight = pending or processing. RLS scopes to the caller's org; we filter
  // to a single id when asked.
  const query = onlyId
    ? db.from("heygen_generations").select(COLS).eq("id", onlyId).in("status", ["pending", "processing"])
    : db.from("heygen_generations").select(COLS).in("status", ["pending", "processing"]);

  const { data, error } = await query;
  if (error) {
    console.error("[heygen] status poll: read failed", error);
    return done({ ok: false, error: "read_failed", polled: 0, settled: [] });
  }

  const rows = ((data ?? []) as unknown as InFlightRow[]).filter((r) => r.heygen_video_id);
  console.log("[heygen] status poll: org", profile.org_id, "in-flight", rows.length);

  const settled: Array<{ id: string; status: string }> = [];
  for (const row of rows) {
    const status = await getVideoStatus(row.heygen_video_id as string);
    if (!status) continue; // transient — leave the row for the next poll
    const result = await applyHeygenCompletion(row, status);
    if (result === "completed" || result === "failed") {
      settled.push({ id: row.id, status: result });
    }
  }

  return done({ ok: true, polled: rows.length, settled });
}
