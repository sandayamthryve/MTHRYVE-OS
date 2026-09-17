import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getTonyGraph } from "@/lib/tony/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tony/graph — the read-only data source for the Tony Cognitive
// Visualization Engine (TCVE). Assembles { nodes, edges, pipeline, meta } from
// the REAL org tables through the caller's RLS-scoped client, so every row is
// org-scoped by Postgres and leadership-only nodes are additionally role-gated
// in getTonyGraph. Never writes; never fabricates — missing values are null.
export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const supabase = createServerSupabaseClient();
  try {
    const graph = await getTonyGraph(supabase, profile);
    return NextResponse.json(graph, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("TCVE graph assembly failed", err);
    return NextResponse.json({ error: "Could not assemble the graph." }, { status: 500 });
  }
}
