import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, StatTile, Card, TableShell, rowClass } from "@/components/ui";
import { PlatformImportForm } from "@/components/platforms/PlatformImportForm";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import { customWindow, manilaStamp } from "@/lib/metrics/windows";
import { fetchCommerceRows, aggregate } from "@/lib/metrics/gmv";
import { getDataFreshness } from "@/lib/metrics/freshness";

// Per-brand × platform performance.
//
// The ORG ROLLUP (the StatTiles) is the source of truth and reads the LIVE
// tiktok_shop_performance set through lib/metrics/gmv (fetchCommerceRows), so its
// GMV reconciles with the Command Center / Reports / CEO to the peso. Ad spend and
// blended ROAS render an honest "—" (the live commerce source carries no ad data).
//
// The RAW BROWSE TABLE below still reads brand_platform_metrics directly — but only
// as an IMPORT/AUDIT view of what was pasted or synced into that table, NOT as a
// source of truth. brand_platform_metrics is DEPRECATED for reads (it disagreed
// with the live figures on every brand); this page keeps the browse view purely so
// managers can see and manage import history. Nothing new should read it — see
// docs/INTEGRATION_PLAN.md ("brand_platform_metrics — DEPRECATED for reads").
type BpmLite = {
  brand_id: string;
  platform: string;
  period_start: string;
  period_end: string;
  gmv: number | null;
  orders: number | null;
  units: number | null;
  returns: number | null;
  fulfillment_errors: number | null;
  ad_spend: number | null;
  ad_revenue: number | null;
  roas: number | null;
  currency: string;
  source: string;
};
type NamedRow = { id: string; name: string };

const PLATFORM_LABEL: Record<string, string> = {
  tiktok_shop: "TikTok Shop",
  shopee: "Shopee",
  lazada: "Lazada",
  meta_ads: "Meta Ads",
  tiktok_ads: "TikTok Ads",
  google_ads: "Google Ads",
  other: "Other",
};

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}
function fmtMoney(n: number, currency = "PHP"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${fmtNum(n)}`;
  }
}

export default async function PlatformsPage({
  searchParams,
}: {
  searchParams?: DateRangeSearchParams;
}) {
  const profile = await requireProfile();
  const canManage = ["ceo", "coo", "department_head"].includes(profile.role);
  const supabase = createServerSupabaseClient();

  // Shared date-range control (defaults to MTD). The org rollup re-slices to the
  // selected window; the raw browse table below stays "latest per brand×platform".
  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const win = customWindow(dr.range.start, dr.range.end, dr.rangeLabel);

  const [metricsRes, brandsRes, bpmRows, freshness] = await Promise.all([
    supabase
      .from("brand_platform_metrics")
      .select(
        "brand_id, platform, period_start, period_end, gmv, orders, units, returns, fulfillment_errors, ad_spend, ad_revenue, roas, currency, source"
      )
      .order("period_end", { ascending: false }),
    supabase.from("brands").select("id, name").order("name"),
    fetchCommerceRows(supabase),
    getDataFreshness(supabase),
  ]);

  const rows = (metricsRes.data ?? []) as unknown as BpmLite[];
  const brands = (brandsRes.data ?? []) as unknown as NamedRow[];
  const brandName = new Map(brands.map((b) => [b.id, b.name]));

  // Windowed org rollup — the shared aggregation, so the totals here match the
  // Command Center / Reports for the same window (no double-count).
  const orgAgg = aggregate(bpmRows, win);
  const blendedRoas = orgAgg.roas;

  // Latest period per brand × platform (rows already sorted newest period first)
  // powers the raw browse table below the rollup.
  const latestByKey = new Map<string, BpmLite>();
  for (const r of rows) {
    const key = `${r.brand_id}::${r.platform}`;
    if (!latestByKey.has(key)) latestByKey.set(key, r);
  }
  const latest = Array.from(latestByKey.values());

  const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));

  latest.sort((a, b) => {
    const byBrand = (brandName.get(a.brand_id) ?? "").localeCompare(brandName.get(b.brand_id) ?? "");
    return byBrand !== 0 ? byBrand : a.platform.localeCompare(b.platform);
  });

  return (
    <AppShell breadcrumb={["Mthryve OS", "Platforms"]} profile={profile}>
      <PageHeader
        title="Platform performance"
        subtitle="Org rollup reads live TikTok Shop GMV (the source of truth). The table below is raw import/sync history — for management, not the headline figures."
      />

      {canManage && (
        <div className="mb-6">
          <PlatformImportForm orgId={profile.org_id} userId={profile.id} brands={brands} />
        </div>
      )}

      {/* Shared date-range control — the org rollup respects the selected window.
          Persisted in the URL (survives refresh). Brand filtering isn't wired on
          this table view, so the picker hides its Brand + Compare levers. */}
      <DateRangeControls {...dr.controlProps} brands={brands} showBrand={false} showCompare={false} />

      {/* Windowed org rollup (shared metrics layer) */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">
          Org rollup <span className="font-mono text-[11px] text-ink-dim">· {win.label}</span>
        </h2>
        {freshness.asOf && (
          <span className="font-mono text-[10px] text-ink-dim">
            Data as of {manilaStamp(freshness.asOf)} · Manila
          </span>
        )}
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile
          label={`GMV · ${win.label}`}
          value={orgAgg.hasData ? fmtMoney(orgAgg.gmv) : "—"}
          valueClassName="text-gold-400"
        />
        <StatTile
          label="Orders"
          value={orgAgg.hasData ? fmtNum(orgAgg.orders) : "—"}
          valueClassName="text-green-400"
        />
        <StatTile label="Ad spend" value={orgAgg.adSpend > 0 ? fmtMoney(orgAgg.adSpend) : "—"} />
        <StatTile label="Blended ROAS" value={blendedRoas != null ? `${Math.round(blendedRoas * 100) / 100}×` : "—"} />
      </div>

      <div className="mb-3">
        <h2 className="text-sm font-semibold text-ink">
          Import / sync history{" "}
          <span className="font-mono text-[11px] text-ink-dim">· raw brand_platform_metrics rows</span>
        </h2>
        <p className="mt-1 text-[11px] text-ink-dim">
          Latest row per brand × platform as pasted or synced into brand_platform_metrics. This table
          is DEPRECATED as a source of truth (it disagreed with live TikTok Shop on every brand) and is
          kept for import history only — the Org rollup above is the live figure the OS actually uses.
        </p>
      </div>

      {latest.length === 0 ? (
        <Card className="text-sm text-ink-muted">
          No import/sync rows on file yet.
          {canManage
            ? " Use “Import platform data” to paste your first week — or connect TikTok Shop / ads via Windsor and it will sync in."
            : ""}
        </Card>
      ) : (
        <TableShell
          columns={[
            "Brand",
            "Platform",
            "GMV",
            "Orders",
            "Returns",
            "Ful. errors",
            "Ad spend",
            "ROAS",
            "Week ending",
          ]}
        >
          {latest.map((r, i) => {
            const roas =
              r.roas != null
                ? Number(r.roas)
                : num(r.ad_spend) > 0
                ? num(r.ad_revenue) / num(r.ad_spend)
                : null;
            return (
              <tr key={i} className={rowClass}>
                <td className="px-4 py-2.5 font-sans text-sm text-ink">
                  {brandName.get(r.brand_id) ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-ink-muted">
                  {PLATFORM_LABEL[r.platform] ?? r.platform}
                </td>
                <td className="px-4 py-2.5 text-gold-400">
                  {r.gmv != null ? fmtMoney(num(r.gmv), r.currency) : "—"}
                </td>
                <td className="px-4 py-2.5 text-ink">
                  {r.orders != null ? fmtNum(num(r.orders)) : "—"}
                </td>
                <td className="px-4 py-2.5 text-ink">
                  {r.returns != null ? fmtNum(num(r.returns)) : "—"}
                </td>
                <td className="px-4 py-2.5 text-gold-400">
                  {r.fulfillment_errors != null ? fmtNum(num(r.fulfillment_errors)) : "—"}
                </td>
                <td className="px-4 py-2.5 text-ink">
                  {r.ad_spend != null ? fmtMoney(num(r.ad_spend), r.currency) : "—"}
                </td>
                <td className="px-4 py-2.5 text-green-400">
                  {roas != null ? `${Math.round(roas * 100) / 100}×` : "—"}
                </td>
                <td className="px-4 py-2.5 text-ink-muted">{r.period_end}</td>
              </tr>
            );
          })}
        </TableShell>
      )}
    </AppShell>
  );
}
