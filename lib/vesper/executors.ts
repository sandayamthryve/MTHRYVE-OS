// lib/vesper/executors.ts — Vesper's six internal executors.
//
// These are Vesper's TOOLS as the Operator agent: each runs an approved
// action_request whose proposed_action.type is one of the VESPER_PLAY_TYPES.
// They are wired into the ONE executor switch (lib/actions/executor.ts) exactly
// like create_lead, so every Vesper play flows through the same spine — pending
// → human-approved → executed — and the surrounding executor records the
// action_audit 'executed' / 'failed' row.
//
// CONTRACT (mirrors the runners in lib/actions/executor.ts):
//   • Each runner takes (db, request) and returns a plain result object that
//     becomes execution_result. It may THROW on a hard failure; the caller
//     (executeApprovedAction) catches, marks the request 'failed', and audits.
//   • INTERNAL ONLY. The reads run against live data; the one writer
//     (generate_scripts) stages reversible content_items ideas. NOTHING reaches
//     anything external — no send, no post, no spend, no new keys.

import { loadWarehouseIntelligence } from "@/lib/warehouse/data";
import { suggestedReplenishQty, type RoutableProduct } from "@/lib/warehouse/actions";
import { last30, monthToDate, resolveWindow, parseWindowKey } from "@/lib/metrics/windows";
import { computeScoreboard } from "@/lib/vesper/scoreboard";
import { buildScriptBriefs } from "@/lib/vesper/scripts";
import type { ActionRequestRow } from "@/lib/actions/types";

type Shim = { from: (t: string) => any };

function payloadOf(request: ActionRequestRow): Record<string, unknown> {
  return request.proposed_action?.payload ?? {};
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

async function brandNameFor(db: Shim, brandId: string | null | undefined): Promise<string | null> {
  if (!brandId) return null;
  const { data } = await db.from("brands").select("name").eq("id", brandId).maybeSingle();
  return (data as { name: string | null } | null)?.name ?? null;
}

// ── generate_scripts ──────────────────────────────────────────────────────────
// Draft script briefs per SKU × pillar × format through the content engine and
// stage them as content_items ideas (status 'idea'), owned by the approver. It
// generates NO final copy (no model call, no spend) — each idea carries the full
// brief, ready to open in Creative Studio.
export async function runGenerateScripts(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = payloadOf(request);
  const brandId = (payload.brand_id as string | undefined) ?? null;
  const sku = (payload.sku as string | undefined) ?? null;
  const pillars = asStringArray(payload.pillars ?? payload.pillar);
  const formats = asStringArray(payload.formats ?? payload.format);

  // Resolve a product name: explicit product_name, else the products row for the
  // SKU, else a neutral placeholder (the brief degrades honestly).
  let productName = ((payload.product_name as string | undefined) ?? "").trim();
  if (!productName && sku) {
    const { data } = await db
      .from("products")
      .select("product_name, brand_id")
      .eq("org_id", request.org_id)
      .eq("sku", sku)
      .maybeSingle();
    const p = data as { product_name: string | null } | null;
    if (p?.product_name) productName = p.product_name;
  }
  if (!productName) productName = sku ? sku : "the product";

  const brandName = await brandNameFor(db, brandId);
  const briefs = buildScriptBriefs(productName, brandName, pillars, formats);

  const now = new Date().toISOString();
  const ids: string[] = [];
  for (const brief of briefs) {
    const { data, error } = await db
      .from("content_items")
      .insert({
        org_id: request.org_id,
        created_by: request.decided_by,
        assignee_id: request.decided_by,
        brand_id: brandId,
        title: brief.title,
        content_type: "script",
        status: "idea",
        pillar: brief.pillarKey,
        brief: brief.brief,
        notes: `Staged by Vesper on approval of a generate_scripts play (${request.id}).`,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();
    if (error || !(data as { id?: string } | null)?.id) {
      throw new Error(error?.message || "Could not stage a script idea.");
    }
    ids.push((data as { id: string }).id);
  }

  return {
    play: "generate_scripts",
    product: productName,
    brand: brandName,
    staged: ids.length,
    content_item_ids: ids,
    items: briefs.map((b) => ({ title: b.title, pillar: b.pillarLabel, format: b.formatLabel })),
  };
}

// ── forecast_restock ──────────────────────────────────────────────────────────
// Run the SHARED warehouse velocity engine and surface the SKUs it routes to
// 'replenish', each with a suggested quantity. Read-only: it orders nothing and
// opens no task — it returns the restock signals for a human to act on.
export async function runForecastRestock(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = payloadOf(request);
  const brandFilter = (payload.brand_id as string | undefined) ?? null;

  const intel = await loadWarehouseIntelligence(db, request.org_id);
  const signals = intel.rows
    .filter((r) => r.route === "replenish")
    .filter((r) => !brandFilter || r.product.brand_id === brandFilter)
    .map((r) => {
      const qty = suggestedReplenishQty(r.product as unknown as RoutableProduct, r.velocity);
      return {
        sku: r.product.sku,
        product_name: r.product.product_name ?? r.product.sku,
        brand: r.brandName,
        movement: r.velocity.movement,
        stock: r.velocity.stock,
        days_of_cover: r.velocity.daysOfCover != null ? Math.round(r.velocity.daysOfCover) : null,
        avg_daily_units: Math.round(r.velocity.avgDailyUnits * 10) / 10,
        suggested_qty: qty,
      };
    })
    .sort((a, b) => (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9));

  return {
    play: "forecast_restock",
    window: { start: intel.windowStart, end: intel.windowEnd },
    count: signals.length,
    signals,
  };
}

// ── next_best_product ─────────────────────────────────────────────────────────
// Read TikTok Shop product momentum + recent live sessions to rank which
// products to push next. Read-only. Ranks by trailing GMV (units as a tiebreak),
// lifted by whether the product's brand has recent live traction.
export async function runNextBestProduct(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = payloadOf(request);
  const brandFilter = (payload.brand_id as string | undefined) ?? null;
  const limit = Number.isFinite(payload.limit as number) ? Math.max(1, Math.min(25, Number(payload.limit))) : 8;
  const win = last30();

  const [prodRes, liveRes, brandRes] = await Promise.all([
    db
      .from("tiktok_product_performance")
      .select("brand_id, sku, product_name, gmv, units, orders, page_views, stat_date")
      .eq("org_id", request.org_id)
      .gte("stat_date", win.start)
      .lte("stat_date", win.end),
    db
      .from("live_sessions")
      .select("brand_id, attributed_gmv, gmv, started_at, status")
      .eq("org_id", request.org_id),
    db.from("brands").select("id, name").eq("org_id", request.org_id),
  ]);

  const brandName = new Map(
    ((brandRes.data ?? []) as Array<{ id: string; name: string }>).map((b) => [b.id, b.name])
  );

  // Recent live traction per brand (attributed GMV over the window), a soft lift.
  const liveByBrand = new Map<string, number>();
  for (const s of (liveRes.data ?? []) as Array<{ brand_id: string | null; attributed_gmv: number | null; gmv: number | null; started_at: string | null }>) {
    if (!s.brand_id) continue;
    if (s.started_at && s.started_at.slice(0, 10) < win.start) continue;
    const g = Number(s.attributed_gmv ?? s.gmv ?? 0);
    liveByBrand.set(s.brand_id, (liveByBrand.get(s.brand_id) ?? 0) + (Number.isFinite(g) ? g : 0));
  }

  // Aggregate product momentum by (brand, sku).
  const agg = new Map<string, { brand_id: string | null; sku: string | null; product_name: string | null; gmv: number; units: number }>();
  for (const p of (prodRes.data ?? []) as Array<{ brand_id: string | null; sku: string | null; product_name: string | null; gmv: number | null; units: number | null }>) {
    if (brandFilter && p.brand_id !== brandFilter) continue;
    const key = `${p.brand_id ?? ""}::${(p.sku ?? "").toLowerCase()}`;
    const a = agg.get(key) ?? { brand_id: p.brand_id, sku: p.sku, product_name: p.product_name, gmv: 0, units: 0 };
    a.gmv += Number(p.gmv ?? 0);
    a.units += Number(p.units ?? 0);
    if (!a.product_name && p.product_name) a.product_name = p.product_name;
    agg.set(key, a);
  }

  const picks = Array.from(agg.values())
    .map((a) => ({
      sku: a.sku,
      product_name: a.product_name ?? a.sku ?? "—",
      brand: a.brand_id ? brandName.get(a.brand_id) ?? null : null,
      gmv_30d: Math.round(a.gmv),
      units_30d: Math.round(a.units),
      live_traction: a.brand_id ? Math.round(liveByBrand.get(a.brand_id) ?? 0) : 0,
      rationale:
        a.gmv > 0
          ? `Trailing GMV ${Math.round(a.gmv)} over 30d${a.brand_id && (liveByBrand.get(a.brand_id) ?? 0) > 0 ? " with recent live traction" : ""}.`
          : "Recent units but no attributed GMV yet.",
    }))
    .sort((x, y) => y.gmv_30d - x.gmv_30d || y.units_30d - x.units_30d || y.live_traction - x.live_traction)
    .slice(0, limit);

  return {
    play: "next_best_product",
    window: { start: win.start, end: win.end },
    count: picks.length,
    picks,
    note: picks.length === 0 ? "No TikTok Shop product data in the window yet." : undefined,
  };
}

// ── match_creators ────────────────────────────────────────────────────────────
// Rank creators from the roster against a brand or campaign. Read-only. Scores
// on category fit, tier rank, attributed GMV and reach, and prefers roster
// creators (not pure prospects). No outreach — it just ranks.
export async function runMatchCreators(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = payloadOf(request);
  const brandId = (payload.brand_id as string | undefined) ?? null;
  const campaign = ((payload.campaign as string | undefined) ?? "").trim() || null;
  let category = ((payload.category as string | undefined) ?? "").trim().toLowerCase() || null;
  const limit = Number.isFinite(payload.limit as number) ? Math.max(1, Math.min(50, Number(payload.limit))) : 10;

  // Default the target category to the brand's category when not given.
  if (!category && brandId) {
    const { data } = await db.from("brands").select("category").eq("id", brandId).maybeSingle();
    const c = (data as { category: string | null } | null)?.category;
    if (c) category = c.trim().toLowerCase();
  }

  const [creatorsRes, tiersRes] = await Promise.all([
    db
      .from("creators")
      .select("id, name, handle, category, follower_count, status, tier, attributed_gmv")
      .eq("org_id", request.org_id),
    db.from("creator_tiers").select("tier, rank").eq("org_id", request.org_id),
  ]);

  const tierRank = new Map(
    ((tiersRes.data ?? []) as Array<{ tier: string; rank: number }>).map((t) => [t.tier, t.rank])
  );
  const maxRank = Math.max(1, ...Array.from(tierRank.values()));

  type C = { id: string; name: string; handle: string | null; category: string | null; follower_count: number | null; status: string | null; tier: string | null; attributed_gmv: number | null };
  const creators = (creatorsRes.data ?? []) as C[];

  const ranked = creators
    .map((c) => {
      const reasons: string[] = [];
      let score = 0;
      // Category fit.
      if (category && (c.category ?? "").toLowerCase().includes(category)) {
        score += 40;
        reasons.push(`category match (${c.category})`);
      }
      // Tier rank (normalised to 30).
      if (c.tier && tierRank.has(c.tier)) {
        const r = tierRank.get(c.tier)!;
        score += Math.round((r / maxRank) * 30);
        reasons.push(`${c.tier} tier`);
      }
      // Proven GMV (up to 20).
      if (c.attributed_gmv != null && Number(c.attributed_gmv) > 0) {
        score += 20;
        reasons.push(`attributed GMV ${Math.round(Number(c.attributed_gmv))}`);
      }
      // Reach (up to 10 by log scale).
      if (c.follower_count && c.follower_count > 0) {
        score += Math.min(10, Math.round(Math.log10(c.follower_count) * 2));
        reasons.push(`${c.follower_count.toLocaleString()} followers`);
      }
      // Active roster preference.
      if ((c.status ?? "").toLowerCase() === "active" || (c.status ?? "").toLowerCase() === "partner") {
        score += 5;
      }
      return {
        id: c.id,
        name: c.name,
        handle: c.handle,
        tier: c.tier,
        category: c.category,
        followers: c.follower_count,
        attributed_gmv: c.attributed_gmv != null ? Math.round(Number(c.attributed_gmv)) : null,
        score,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || (b.attributed_gmv ?? 0) - (a.attributed_gmv ?? 0))
    .slice(0, limit);

  return {
    play: "match_creators",
    brand_id: brandId,
    campaign,
    target_category: category,
    count: ranked.length,
    matches: ranked,
    note: ranked.length === 0 ? "No creators in the roster yet." : undefined,
  };
}

// ── analyze_content_performance ───────────────────────────────────────────────
// Read content_performance and surface what converts — by format (content type)
// and by platform. Read-only. Honest: null metrics are ignored, never zeroed;
// an empty table returns an empty analysis.
export async function runAnalyzeContentPerformance(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = payloadOf(request);
  const brandFilter = (payload.brand_id as string | undefined) ?? null;

  const perfRes = await db
    .from("content_performance")
    .select("content_item_id, brand_id, platform, views, clicks, conversions, orders, gmv, engagement_rate, ctr")
    .eq("org_id", request.org_id);
  let rows = (perfRes.data ?? []) as Array<{
    content_item_id: string | null;
    brand_id: string | null;
    platform: string | null;
    views: number | null;
    clicks: number | null;
    conversions: number | null;
    orders: number | null;
    gmv: number | null;
    engagement_rate: number | null;
    ctr: number | null;
  }>;
  if (brandFilter) rows = rows.filter((r) => r.brand_id === brandFilter);

  if (rows.length === 0) {
    return { play: "analyze_content_performance", sampled: 0, by_format: [], by_platform: [], note: "No content performance data yet." };
  }

  // Join content_type for the "by format" cut.
  const itemIds = Array.from(new Set(rows.map((r) => r.content_item_id).filter(Boolean))) as string[];
  const typeById = new Map<string, string>();
  if (itemIds.length) {
    const { data } = await db.from("content_items").select("id, content_type").in("id", itemIds);
    for (const it of (data ?? []) as Array<{ id: string; content_type: string | null }>) {
      typeById.set(it.id, it.content_type ?? "unspecified");
    }
  }

  type Bucket = { key: string; n: number; gmv: number; conversions: number; clicks: number; views: number; engSum: number; engN: number; ctrSum: number; ctrN: number };
  const blank = (key: string): Bucket => ({ key, n: 0, gmv: 0, conversions: 0, clicks: 0, views: 0, engSum: 0, engN: 0, ctrSum: 0, ctrN: 0 });
  const fold = (map: Map<string, Bucket>, key: string, r: (typeof rows)[number]) => {
    const b = map.get(key) ?? blank(key);
    b.n += 1;
    b.gmv += Number(r.gmv ?? 0);
    b.conversions += Number(r.conversions ?? 0);
    b.clicks += Number(r.clicks ?? 0);
    b.views += Number(r.views ?? 0);
    if (r.engagement_rate != null) { b.engSum += Number(r.engagement_rate); b.engN += 1; }
    if (r.ctr != null) { b.ctrSum += Number(r.ctr); b.ctrN += 1; }
    map.set(key, b);
  };

  const byFormat = new Map<string, Bucket>();
  const byPlatform = new Map<string, Bucket>();
  for (const r of rows) {
    const fmt = r.content_item_id ? typeById.get(r.content_item_id) ?? "unspecified" : "unspecified";
    fold(byFormat, fmt, r);
    fold(byPlatform, (r.platform ?? "unspecified").toLowerCase(), r);
  }

  const finalize = (b: Bucket) => ({
    key: b.key,
    pieces: b.n,
    gmv: Math.round(b.gmv),
    conversions: b.conversions,
    conversion_rate: b.clicks > 0 ? Math.round((b.conversions / b.clicks) * 1000) / 10 : b.views > 0 ? Math.round((b.conversions / b.views) * 1000) / 10 : null,
    avg_engagement_rate: b.engN > 0 ? Math.round((b.engSum / b.engN) * 100) / 100 : null,
    avg_ctr: b.ctrN > 0 ? Math.round((b.ctrSum / b.ctrN) * 100) / 100 : null,
  });

  const byFormatArr = Array.from(byFormat.values()).map(finalize).sort((a, b) => b.gmv - a.gmv);
  const byPlatformArr = Array.from(byPlatform.values()).map(finalize).sort((a, b) => b.gmv - a.gmv);

  return {
    play: "analyze_content_performance",
    sampled: rows.length,
    by_format: byFormatArr,
    by_platform: byPlatformArr,
    best_converting_format: byFormatArr.slice().sort((a, b) => (b.conversion_rate ?? -1) - (a.conversion_rate ?? -1))[0]?.key ?? null,
  };
}

// ── compile_scoreboard ────────────────────────────────────────────────────────
// Assemble the Growth Scoreboard (per pod + org-wide) from live data. Read-only.
export async function runCompileScoreboard(
  db: Shim,
  request: ActionRequestRow
): Promise<Record<string, unknown>> {
  const payload = payloadOf(request);
  const windowKey = typeof payload.window === "string" ? parseWindowKey(payload.window) : null;
  const window = windowKey ? resolveWindow(windowKey) : monthToDate();
  const board = await computeScoreboard(db, request.org_id, window);

  return {
    play: "compile_scoreboard",
    window: { key: board.window.key, label: board.window.label, start: board.window.start, end: board.window.end },
    org: board.org,
    pods: board.pods,
    unassigned_brands: board.unassignedBrandCount,
  };
}
