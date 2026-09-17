// lib/ad-ops/performance.ts — Vesper's AD PERFORMANCE READER. Pulls TikTok Ads
// + Meta Ads campaign performance from Windsor.ai (read API), normalises it to
// AdCampaignPerformance, and attaches a brand where the account is mapped.
//
// Honest-by-construction: it requests ONLY field ids verified valid for each
// connector (Windsor get_fields, STEP 0 audit) so a live pull actually returns;
// every metric is nullable and a metric a connector doesn't expose stays null
// rather than being invented. When WINDSOR_API_KEY is absent the reader reports
// configured=false and returns no rows (the UI shows "ad connector not
// configured"); a Windsor error for one platform is captured in `errors` and
// never masks the other platform's real data.

import {
  getWindsorData,
  isWindsorNotConfigured,
  isWindsorConfigured,
  WindsorApiError,
  type WindsorRow,
} from "@/lib/windsor/client";
import { buildBrandResolver, type BrandLite } from "@/lib/windsor/brands";
import {
  CONNECTOR_BY_PLATFORM,
  PLATFORM_BY_CONNECTOR,
  type AdCampaignPerformance,
  type AdPlatform,
  type WindsorConnector,
} from "./types";

// The platforms this loop reads, in display order.
export const AD_PLATFORMS: AdPlatform[] = ["tiktok_ads", "meta_ads"];

// Verified-valid Windsor field ids per connector (get_fields). Requesting an
// unknown field errors the whole call, so these are deliberately conservative:
//   • both: account_id, account_name, campaign, campaign_id, spend, clicks,
//           impressions, cpc, ctr
//   • tiktok additionally exposes `conversions`; Meta (facebook) does not in
//     this field set, and neither connected account exposes revenue/ROAS.
const FIELDS_BY_CONNECTOR: Record<WindsorConnector, string[]> = {
  facebook: ["account_id", "account_name", "campaign", "campaign_id", "spend", "clicks", "impressions", "cpc", "ctr"],
  tiktok: [
    "account_id",
    "account_name",
    "campaign",
    "campaign_id",
    "spend",
    "clicks",
    "impressions",
    "cpc",
    "ctr",
    "conversions",
  ],
};

// Account currency for spend/budget. Windsor returns spend unlabeled; the
// team's accounts are PHP (INTEGRATION_PLAN.md). Override with WINDSOR_CURRENCY.
export function adCurrency(): string {
  return process.env.WINDSOR_CURRENCY?.trim() || "PHP";
}

export interface AdPerformanceReadResult {
  configured: boolean;
  rows: AdCampaignPerformance[];
  // Per-platform failures (platform → message). Empty when all reads succeeded.
  errors: Array<{ platform: AdPlatform; message: string }>;
}

// Read TikTok + Meta campaign performance over the window, brand-attributed.
// `brands` supplies the id/name pairs the env brand-map keys resolve against.
export async function readAdPerformance(
  brands: BrandLite[],
  opts: { datePreset?: string; dateFrom?: string; dateTo?: string } = {}
): Promise<AdPerformanceReadResult> {
  if (!isWindsorConfigured()) {
    return { configured: false, rows: [], errors: [] };
  }
  const datePreset = opts.datePreset ?? "last_7d";
  const resolveBrand = buildBrandResolver(brands);
  const currency = adCurrency();

  const rows: AdCampaignPerformance[] = [];
  const errors: AdPerformanceReadResult["errors"] = [];

  // Pull both connectors concurrently; one failing never blocks the other.
  await Promise.all(
    AD_PLATFORMS.map(async (platform) => {
      const connector = CONNECTOR_BY_PLATFORM[platform];
      try {
        const data = await getWindsorData(connector, {
          fields: FIELDS_BY_CONNECTOR[connector],
          datePreset,
          dateFrom: opts.dateFrom,
          dateTo: opts.dateTo,
        });
        rows.push(...normalise(connector, data, resolveBrand, currency));
      } catch (e) {
        // A missing key would have been caught above; here it's a real API
        // failure — surface it, never fabricate rows for this platform.
        if (isWindsorNotConfigured(e)) return;
        const message = e instanceof WindsorApiError ? e.message : e instanceof Error ? e.message : String(e);
        errors.push({ platform, message });
      }
    })
  );

  // Stable order: platform, then spend desc (biggest campaigns first).
  rows.sort(
    (a, b) => a.platform.localeCompare(b.platform) || (b.spend ?? 0) - (a.spend ?? 0)
  );
  return { configured: true, rows, errors };
}

// Aggregate raw Windsor rows to one AdCampaignPerformance per campaign (summing
// metrics in case Windsor split a campaign across rows) and recompute the
// derived ratios from the sums, falling back to Windsor's provided ctr/cpc.
function normalise(
  connector: WindsorConnector,
  data: WindsorRow[],
  resolveBrand: (c: WindsorConnector, accountId: string) => { brandId: string; brandName: string } | null,
  currency: string
): AdCampaignPerformance[] {
  const platform = PLATFORM_BY_CONNECTOR[connector];
  const acc = new Map<
    string,
    {
      accountId: string;
      accountName: string | null;
      campaignId: string;
      campaignName: string;
      spend: number | null;
      clicks: number | null;
      impressions: number | null;
      conversions: number | null;
      revenue: number | null;
      ctrRaw: number | null;
      cpcRaw: number | null;
    }
  >();

  for (const r of data) {
    const accountId = str(r["account_id"]) ?? "";
    const campaignId = str(r["campaign_id"]) ?? "";
    // A row with no campaign id can't be acted on — skip it rather than guess.
    if (!campaignId) continue;
    const key = `${accountId}::${campaignId}`;
    const prev = acc.get(key);
    const spend = num(r["spend"]);
    const clicks = num(r["clicks"]);
    const impressions = num(r["impressions"]);
    const conversions = num(r["conversions"]);
    const revenue = num(r["revenue"]) ?? num(r["total_conversion_value"]);
    const next = {
      accountId,
      accountName: str(r["account_name"]) ?? prev?.accountName ?? null,
      campaignId,
      campaignName: str(r["campaign"]) ?? prev?.campaignName ?? campaignId,
      spend: addNullable(prev?.spend, spend),
      clicks: addNullable(prev?.clicks, clicks),
      impressions: addNullable(prev?.impressions, impressions),
      conversions: addNullable(prev?.conversions, conversions),
      revenue: addNullable(prev?.revenue, revenue),
      // Keep the last provided ctr/cpc as a fallback when we can't recompute.
      ctrRaw: num(r["ctr"]) ?? prev?.ctrRaw ?? null,
      cpcRaw: num(r["cpc"]) ?? prev?.cpcRaw ?? null,
    };
    acc.set(key, next);
  }

  const out: AdCampaignPerformance[] = [];
  for (const v of acc.values()) {
    // Recompute ratios from sums where possible; else use Windsor's values.
    const ctr =
      v.impressions != null && v.impressions > 0 && v.clicks != null
        ? round((v.clicks / v.impressions) * 100, 2)
        : v.ctrRaw;
    const cpc =
      v.clicks != null && v.clicks > 0 && v.spend != null ? round(v.spend / v.clicks, 2) : v.cpcRaw;
    const roas =
      v.revenue != null && v.spend != null && v.spend > 0 ? round(v.revenue / v.spend, 2) : null;
    const brand = resolveBrand(connector, v.accountId);
    out.push({
      platform,
      connector,
      accountId: v.accountId,
      accountName: v.accountName,
      campaignId: v.campaignId,
      campaignName: v.campaignName,
      brandId: brand?.brandId ?? null,
      brandName: brand?.brandName ?? null,
      spend: v.spend,
      clicks: v.clicks,
      impressions: v.impressions,
      conversions: v.conversions,
      revenue: v.revenue,
      ctr,
      cpc,
      roas,
      currency,
    });
  }
  return out;
}

// ── coercion helpers ──────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function addNullable(a: number | null | undefined, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
