// lib/affiliate/data.ts — server-side data layer for the affiliate performance
// standard. Loads the creator registry, tier bands and the ISO-week posting
// counts, then computes each creator's StandardKpi in one place so the registry
// list and the creator detail view grade identically. No writes.
//
// The affiliate tables aren't in the generated Database types, so callers pass
// the same cast shim the rest of the module uses.

import type { IsoWeekWindow } from "@/lib/metrics/windows";
import {
  computeStandardKpi,
  type StandardCreator,
  type StandardKpi,
  type TierRow,
} from "./standards";

type Shim = { from: (t: string) => any };

// The registry creator carries the KPI inputs plus the display columns the list
// shows (platform / category / status).
export interface RegistryCreator extends StandardCreator {
  platform: string;
  category: string | null;
  status: string;
}

export interface RegistryRow {
  creator: RegistryCreator;
  kpi: StandardKpi;
  activeDealId: string | null; // first ACTIVE affiliate deal, if any
}

export interface StandardsRegistry {
  rows: RegistryRow[];
  tiers: TierRow[];
  week: IsoWeekWindow;
}

export async function loadStandardsRegistry(
  db: Shim,
  week: IsoWeekWindow
): Promise<StandardsRegistry> {
  const startIso = new Date(week.startUtcMs).toISOString();
  const endIso = new Date(week.endUtcMs).toISOString(); // exclusive

  const [creatorsRes, tiersRes, weekPostsRes, everPostsRes, dealsRes] = await Promise.all([
    db
      .from("creators")
      .select(
        "id, name, handle, platform, category, status, tier, follower_count, posts_committed, attributed_gmv, owner_id"
      )
      .order("name"),
    db
      .from("creator_tiers")
      .select("tier, rank, min_following, max_following, min_gmv, gmv_period, required_post_rate_pct")
      .order("rank"),
    db
      .from("creator_posts")
      .select("creator_id")
      .eq("status", "posted")
      .gte("posted_at", startIso)
      .lt("posted_at", endIso),
    db.from("creator_posts").select("creator_id").eq("status", "posted"),
    db.from("affiliate_deals").select("id, creator_id, status"),
  ]);

  const creators = (creatorsRes.data ?? []) as RegistryCreator[];
  const tiers = (tiersRes.data ?? []) as TierRow[];

  const deliveredByCreator = new Map<string, number>();
  for (const p of (weekPostsRes.data ?? []) as Array<{ creator_id: string | null }>) {
    if (!p.creator_id) continue;
    deliveredByCreator.set(p.creator_id, (deliveredByCreator.get(p.creator_id) ?? 0) + 1);
  }

  const everPosted = new Set<string>();
  for (const p of (everPostsRes.data ?? []) as Array<{ creator_id: string | null }>) {
    if (p.creator_id) everPosted.add(p.creator_id);
  }

  const activeDealByCreator = new Map<string, string>();
  for (const d of (dealsRes.data ?? []) as Array<{
    id: string;
    creator_id: string | null;
    status: string;
  }>) {
    if (d.status === "active" && d.creator_id && !activeDealByCreator.has(d.creator_id)) {
      activeDealByCreator.set(d.creator_id, d.id);
    }
  }

  const rows: RegistryRow[] = creators.map((creator) => ({
    creator,
    kpi: computeStandardKpi({
      creator,
      tiers,
      delivered: deliveredByCreator.get(creator.id) ?? 0,
      hasEverPosted: everPosted.has(creator.id),
    }),
    activeDealId: activeDealByCreator.get(creator.id) ?? null,
  }));

  return { rows, tiers, week };
}
