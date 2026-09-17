// lib/vesper/scoreboard.ts — the Growth Scoreboard engine.
//
// Tony's weekly cockpit: the playbook KPIs computed from LIVE data, per pod and
// org-wide. One function assembles the whole board so the /scoreboard page and
// the compile_scoreboard executor render exactly the same numbers.
//
// HONESTY RULE (matches the rest of the metrics layer): nothing is fabricated.
// A KPI that can't be measured yet returns null and the UI renders an em-dash —
// never a zero dressed up as a real figure. Specifically:
//   • GMV comes from the shared GMV engine, now sourced from the LIVE
//     tiktok_shop_performance table (lib/metrics/gmv → fetchCommerceRows), NOT the
//     retired brand_platform_metrics. No rows → hasGmv false. ROAS is null (the
//     live commerce source carries no ad data — an honest "—", never a bpm figure).
//   • Pod contribution % needs cost/fee data (brand_finance). With none on file,
//     contribution is null ("—") rather than guessed.
//   • Concentration risk = the top single client's share of GMV. Null with no GMV.
//   • Retention/churn is null unless a brand has actually left 'active' — with an
//     all-active roster and no lifecycle history there's no honest retention rate.

import { aggregate, fetchCommerceRows, type BpmRow, type GmvAgg } from "@/lib/metrics/gmv";
import { monthToDate, type ResolvedWindow } from "@/lib/metrics/windows";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

type Shim = { from: (t: string) => any };

// Brands whose status marks them as no longer an active client. Everything else
// (default 'active') counts as retained.
const CHURNED_STATUSES = new Set(["churned", "inactive", "lost", "paused", "archived", "ended"]);

interface PodRow {
  id: string;
  name: string;
  lead_user_id: string | null;
  target_brands: number | null;
  status: string;
}
interface PodBrandRow {
  pod_id: string;
  brand_id: string;
}
interface BrandRow {
  id: string;
  name: string;
  status: string;
}
interface BrandFinanceRow {
  brand_id: string;
  take_pct: number | null;
  retainer_monthly: number | null;
}
interface UserRow {
  id: string;
  full_name: string;
}

export interface PodScore {
  podId: string;
  name: string;
  leadName: string | null;
  status: string;
  targetBrands: number | null;
  brandCount: number; // brands under this pod's management
  brandNames: string[];
  gmv: number;
  hasGmv: boolean;
  roas: number | null;
  agencyRevenue: number | null; // null when no cost/fee data on the pod's brands
  contributionPct: number | null; // pod agency revenue ÷ org agency revenue
  concentrationPct: number | null; // top client's share of the pod's GMV
}

export interface OrgScore {
  windowLabel: string;
  totalBrands: number;
  brandsUnderManagement: number; // brands assigned to any pod
  activeBrands: number;
  gmv: number;
  hasGmv: boolean;
  roas: number | null;
  agencyRevenue: number | null;
  contributionMeasurable: boolean; // any brand_finance data at all
  concentrationPct: number | null; // top client's share of ORG GMV
  topClientName: string | null;
  retentionPct: number | null; // null when not measurable
  churnedCount: number | null; // null when there's no lifecycle signal
}

export interface Scoreboard {
  window: ResolvedWindow;
  org: OrgScore;
  pods: PodScore[];
  unassignedBrandCount: number;
}

// Agency revenue attributable to a brand for the window, from its finance model:
// GMV × take% (+ its monthly retainer). Returns null when there's no finance row
// so "we can't measure contribution" stays honest rather than a silent zero.
function agencyRevenueFor(gmv: number, bf: BrandFinanceRow | undefined): number | null {
  if (!bf) return null;
  const take = bf.take_pct != null ? Number(bf.take_pct) : 0;
  const retainer = bf.retainer_monthly != null ? Number(bf.retainer_monthly) : 0;
  return (gmv * take) / 100 + retainer;
}

// Assemble the full board for an org and window. `db` is the caller's RLS-scoped
// client (page) or the service-role client (executor) — either works; the reads
// are org-scoped explicitly too.
export async function computeScoreboard(
  db: Shim,
  orgId: string,
  window: ResolvedWindow = monthToDate()
): Promise<Scoreboard> {
  const [podsRes, podBrandsRes, brandsRes, rows, financeRes, usersRes] = await Promise.all([
    db.from("pods").select("id, name, lead_user_id, target_brands, status").eq("org_id", orgId).order("name"),
    db.from("pod_brands").select("pod_id, brand_id").eq("org_id", orgId),
    db.from("brands").select("id, name, status").eq("org_id", orgId),
    // GMV from the LIVE tiktok_shop_performance set (org-scoped explicitly, so a
    // service-role executor stays inside the org too) — never brand_platform_metrics.
    fetchCommerceRows(db as unknown as ReturnType<typeof createServerSupabaseClient>, { orgId }),
    db.from("brand_finance").select("brand_id, take_pct, retainer_monthly").eq("org_id", orgId),
    db.from("users").select("id, full_name").eq("org_id", orgId),
  ]);

  const pods = (podsRes.data ?? []) as PodRow[];
  const podBrands = (podBrandsRes.data ?? []) as PodBrandRow[];
  const brands = (brandsRes.data ?? []) as BrandRow[];
  const finance = (financeRes.data ?? []) as BrandFinanceRow[];
  const users = (usersRes.data ?? []) as UserRow[];

  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const userName = new Map(users.map((u) => [u.id, u.full_name]));
  const financeByBrand = new Map(finance.map((f) => [f.brand_id, f]));
  const contributionMeasurable = finance.length > 0;

  // Per-brand aggregate off the SAME fetched rows, so pod totals reconcile with
  // the org total (the GMV engine's invariant).
  const brandAgg = new Map<string, GmvAgg>();
  for (const b of brands) brandAgg.set(b.id, aggregate(rows, window, { brandId: b.id }));
  const orgAgg = aggregate(rows, window);

  const gmvOf = (brandId: string): number => brandAgg.get(brandId)?.gmv ?? 0;

  // ── Org agency revenue (only counts brands that HAVE finance data) ───────────
  let orgAgencyRevenue: number | null = null;
  if (contributionMeasurable) {
    let sum = 0;
    for (const b of brands) {
      const rev = agencyRevenueFor(gmvOf(b.id), financeByBrand.get(b.id));
      if (rev != null) sum += rev;
    }
    orgAgencyRevenue = sum;
  }

  // ── Concentration risk (top single client's share of org GMV) ────────────────
  let topClientName: string | null = null;
  let orgConcentration: number | null = null;
  if (orgAgg.gmv > 0) {
    let topId: string | null = null;
    let topGmv = -1;
    for (const b of brands) {
      const g = gmvOf(b.id);
      if (g > topGmv) {
        topGmv = g;
        topId = b.id;
      }
    }
    if (topId && topGmv > 0) {
      topClientName = brandName.get(topId) ?? null;
      orgConcentration = (topGmv / orgAgg.gmv) * 100;
    }
  }

  // ── Retention / churn (honest: null unless a brand has left 'active') ────────
  const churnedCount = brands.filter((b) => CHURNED_STATUSES.has((b.status ?? "").toLowerCase())).length;
  const activeBrands = brands.length - churnedCount;
  const retentionPct = brands.length > 0 && churnedCount > 0 ? (activeBrands / brands.length) * 100 : null;

  // ── Per-pod rows ─────────────────────────────────────────────────────────────
  const brandsByPod = new Map<string, string[]>();
  for (const pb of podBrands) {
    const list = brandsByPod.get(pb.pod_id) ?? [];
    list.push(pb.brand_id);
    brandsByPod.set(pb.pod_id, list);
  }

  const podScores: PodScore[] = pods.map((p) => {
    const brandIds = brandsByPod.get(p.id) ?? [];
    let gmv = 0;
    let adSpend = 0;
    let adRevenue = 0;
    let podAgencyRevenue: number | null = contributionMeasurable ? 0 : null;
    let topGmv = 0;

    for (const bId of brandIds) {
      const agg = brandAgg.get(bId);
      const g = agg?.gmv ?? 0;
      gmv += g;
      adSpend += agg?.adSpend ?? 0;
      adRevenue += agg?.adRevenue ?? 0;
      if (g > topGmv) topGmv = g;
      if (podAgencyRevenue != null) {
        const rev = agencyRevenueFor(g, financeByBrand.get(bId));
        if (rev != null) podAgencyRevenue += rev;
      }
    }

    const roas = adSpend > 0 ? adRevenue / adSpend : null;
    const concentrationPct = gmv > 0 && topGmv > 0 ? (topGmv / gmv) * 100 : null;
    const contributionPct =
      podAgencyRevenue != null && orgAgencyRevenue != null && orgAgencyRevenue > 0
        ? (podAgencyRevenue / orgAgencyRevenue) * 100
        : null;

    return {
      podId: p.id,
      name: p.name,
      leadName: p.lead_user_id ? userName.get(p.lead_user_id) ?? null : null,
      status: p.status,
      targetBrands: p.target_brands,
      brandCount: brandIds.length,
      brandNames: brandIds.map((id) => brandName.get(id) ?? "—").sort(),
      gmv,
      hasGmv: gmv > 0,
      roas,
      agencyRevenue: podAgencyRevenue,
      contributionPct,
      concentrationPct,
    };
  });

  const assignedBrandIds = new Set(podBrands.map((pb) => pb.brand_id));

  const org: OrgScore = {
    windowLabel: window.label,
    totalBrands: brands.length,
    brandsUnderManagement: assignedBrandIds.size,
    activeBrands,
    gmv: orgAgg.gmv,
    hasGmv: orgAgg.hasData,
    roas: orgAgg.roas,
    agencyRevenue: orgAgencyRevenue,
    contributionMeasurable,
    concentrationPct: orgConcentration,
    topClientName,
    retentionPct,
    churnedCount: brands.length > 0 ? churnedCount : null,
  };

  return {
    window,
    org,
    pods: podScores,
    unassignedBrandCount: brands.length - assignedBrandIds.size,
  };
}
