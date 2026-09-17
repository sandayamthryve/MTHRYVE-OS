// lib/metrics/freshness.ts — "Data as of <last update, Manila>" freshness stamp.
//
// The newest real signal we have that the commerce data changed is, in order:
//   1. the most recent tiktok_sync_runs.finished_at (a real sync completing), and
//   2. failing that, the newest synced_at across tiktok_shop_performance (the last
//      time the live commerce table landed a row).
// tiktok_sync_runs is leadership-only under RLS, so for a team member step 1
// returns nothing and step 2 supplies an honest fallback. When neither exists,
// asOf is null and the UI shows "no data yet" rather than a fabricated time.
//
// The fallback reads tiktok_shop_performance (the live source every commerce
// surface now uses), NOT the retired brand_platform_metrics — whose writer trails
// the live table by days, so it would stamp the page "as of" a stale time.

import type { createServerSupabaseClient } from "@/lib/supabase/server";

type Client = ReturnType<typeof createServerSupabaseClient>;

export interface DataFreshness {
  asOf: string | null; // ISO timestamp of the newest signal, or null
  source: "sync" | "metrics" | null; // which signal it came from
}

// tiktok_sync_runs is not in the generated types (it's an RLS-guarded operational
// table); read it through a minimal structural shim.
type SyncRunsShim = {
  from: (t: string) => {
    select: (c: string) => {
      not: (
        c: string,
        op: string,
        v: null
      ) => {
        order: (
          c: string,
          o: { ascending: boolean }
        ) => { limit: (n: number) => Promise<{ data: { finished_at: string }[] | null }> };
      };
    };
  };
};

export async function getDataFreshness(supabase: Client): Promise<DataFreshness> {
  // 1. Newest completed sync (leadership-only; may be empty for team members).
  try {
    const { data } = await (supabase as unknown as SyncRunsShim)
      .from("tiktok_sync_runs")
      .select("finished_at")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1);
    const finished = data?.[0]?.finished_at;
    if (finished) return { asOf: finished, source: "sync" };
  } catch {
    // fall through to the metrics fallback
  }

  // 2. Fallback: newest landed row in the live tiktok_shop_performance table.
  const { data: metricRows } = await (supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        order: (
          c: string,
          o: { ascending: boolean }
        ) => { limit: (n: number) => Promise<{ data: { synced_at?: string }[] | null }> };
      };
    };
  })
    .from("tiktok_shop_performance")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1);
  const updated = metricRows?.[0]?.synced_at;
  if (updated) return { asOf: updated, source: "metrics" };

  return { asOf: null, source: null };
}
