import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass, Badge, HelpHint } from "@/components/ui";
import { AffiliateTabs } from "@/components/affiliate/AffiliateTabs";
import { requireDepartment } from "@/lib/auth/session";
import { AFFILIATE_DEPTS, AFFILIATE_EXTRA_USER_IDS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { intOrDash, pesoOrDash, EMPTY } from "@/lib/metrics/format";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import {
  AFFILIATE_METRICS_DEPT,
  rollUpKpi,
  type LinkedCreatorLite,
} from "@/lib/affiliate/domain";
import { createCampaign } from "./actions";
import { CAMPAIGN_TYPE_LABEL } from "@/lib/campaigns/types";

// SECTION 1 — Affiliate campaigns hub. Lists campaigns (op_records,
// record_type='campaign') with a LIVE KPI roll-up per campaign derived from the
// linked creators + their attributed content — never the KPI target echoed back
// as an actual. The Measure panel reads the Affiliate metrics floor (freshest
// value per metric). Honest nulls throughout: an unknown reads "—", never 0.
export const dynamic = "force-dynamic";

type Db = { from: (t: string) => any };

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

type CampaignRow = {
  id: string;
  title: string | null;
  brand_id: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  details: { kpi_target?: Record<string, number | null>; fit?: Record<string, unknown> } | null;
  created_at: string | null;
};

// Format a metric value by its catalog unit. null → em-dash (never a fake 0).
function formatMetric(value: number | null, unit: string | null): string {
  if (value == null) return EMPTY;
  switch (unit) {
    case "currency":
      return pesoOrDash(value);
    case "percent":
      return `${Math.round(Number(value) * 100) / 100}%`;
    default:
      return intOrDash(value);
  }
}

export default async function AffiliatePage({
  searchParams,
}: {
  searchParams?: DateRangeSearchParams;
}) {
  // Affiliate Reach follows the PDF module grant. RLS still scopes its rows.
  const profile = await requireModule("/affiliate");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // Shared date-range control (defaults to MTD). The Measure panel reads the
  // Affiliate metrics floor over the selected window; campaign roll-ups are
  // relationship counts and stay window-independent.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const range = dr.range;

  const [campaignsRes, linksRes, creatorsRes, contentRes, brandsRes, catalogRes, entriesRes, mktCampaignsRes] =
    await Promise.all([
      db
        .from("op_records")
        .select("id, title, brand_id, status, start_date, end_date, details, created_at")
        .eq("record_type", "campaign")
        .order("created_at", { ascending: false }),
      db.from("affiliate_campaign_creators").select("campaign_id, creator_id"),
      db.from("creators").select("id, status, follower_count"),
      db.from("affiliate_content").select("campaign_id, gmv"),
      supabase.from("brands").select("id, name").order("name"),
      db
        .from("metric_catalog")
        .select("metric_key, label, unit, category, sort_order")
        .eq("department", AFFILIATE_METRICS_DEPT)
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      db
        .from("metric_entries")
        .select("metric_key, manual_value, api_value, period_start, period_end, updated_at")
        .eq("department", AFFILIATE_METRICS_DEPT)
        .lte("period_start", range.end)
        .gte("period_end", range.start),
      // Marketing campaigns of type 'affiliate' — the SAME public.campaigns table
      // the Commerce area manages, filtered to the affiliate kind. Kept separate
      // from the op_records campaign list above (they are different tables). RLS
      // scopes rows; archived rows are hidden.
      supabase
        .from("campaigns")
        .select("id, name, brand_id, status, type, start_date, end_date, created_at")
        .eq("type", "affiliate")
        .is("archived_at", null)
        .order("created_at", { ascending: false }),
    ]);

  const campaigns = (campaignsRes.data ?? []) as CampaignRow[];
  const links = (linksRes.data ?? []) as { campaign_id: string; creator_id: string }[];
  const creators = (creatorsRes.data ?? []) as (LinkedCreatorLite & { id: string })[];
  const content = (contentRes.data ?? []) as { campaign_id: string | null; gmv: number | null }[];
  const brands = (brandsRes.data ?? []) as { id: string; name: string }[];
  const brandName = (id: string | null) => (id ? brands.find((b) => b.id === id)?.name ?? EMPTY : EMPTY);

  // Affiliate-type rows from public.campaigns (one table, filtered by type).
  const mktCampaigns = (mktCampaignsRes.data ?? []) as {
    id: string;
    name: string;
    brand_id: string | null;
    status: string | null;
    type: string | null;
    start_date: string | null;
    end_date: string | null;
    created_at: string | null;
  }[];

  // Index creators by id, and content GMV by campaign, so each campaign's KPI is
  // a real roll-up over its own linked creators + attributed content.
  const creatorById = new Map(creators.map((c) => [c.id, c]));
  const linksByCampaign = new Map<string, string[]>();
  for (const l of links) {
    const arr = linksByCampaign.get(l.campaign_id) ?? [];
    arr.push(l.creator_id);
    linksByCampaign.set(l.campaign_id, arr);
  }
  const contentGmvByCampaign = new Map<string, (number | null)[]>();
  for (const c of content) {
    if (!c.campaign_id) continue;
    const arr = contentGmvByCampaign.get(c.campaign_id) ?? [];
    arr.push(c.gmv);
    contentGmvByCampaign.set(c.campaign_id, arr);
  }

  const rows = campaigns.map((c) => {
    const linkedCreators = (linksByCampaign.get(c.id) ?? [])
      .map((id) => creatorById.get(id))
      .filter(Boolean) as LinkedCreatorLite[];
    const kpi = rollUpKpi(linkedCreators, contentGmvByCampaign.get(c.id) ?? []);
    return { c, kpi };
  });

  // ── Measure panel: freshest Affiliate metric value per metric_key ───────────
  const catalog = (catalogRes.data ?? []) as {
    metric_key: string;
    label: string;
    unit: string | null;
    category: string | null;
    sort_order: number;
  }[];
  const entries = (entriesRes.data ?? []) as {
    metric_key: string;
    manual_value: number | null;
    api_value: number | null;
    period_start: string | null;
    period_end: string | null;
    updated_at: string | null;
  }[];
  // Freshest entry per metric_key by updated_at; manual is the encoded floor and
  // wins over an api value, else the api value, else nothing.
  const freshest = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const prev = freshest.get(e.metric_key);
    if (!prev || (e.updated_at ?? "") > (prev.updated_at ?? "")) freshest.set(e.metric_key, e);
  }
  const measure = catalog.map((m) => {
    const e = freshest.get(m.metric_key);
    const value = e ? (e.manual_value != null ? e.manual_value : e.api_value) : null;
    return { ...m, value: value == null ? null : Number(value) };
  });

  // Portfolio tiles — real sums across all campaigns. Counts are true counts;
  // reach/GMV stay null when nothing contributed.
  const totalCampaigns = campaigns.length;
  const totalSourced = rows.reduce((a, r) => a + r.kpi.sourced, 0);
  const totalActive = rows.reduce((a, r) => a + r.kpi.active, 0);
  const reachVals = rows.map((r) => r.kpi.reach).filter((v): v is number => v != null);
  const totalReach = reachVals.length ? reachVals.reduce((a, v) => a + v, 0) : null;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Affiliate"]} profile={profile}>
      <PageHeader
        title={<>Affiliate <HelpHint id="commerce.affiliate" /></>}
        subtitle="Campaigns, sourcing & the qualification pipeline — one home for the affiliate program."
      />
      <AffiliateTabs />

      {/* Shared date-range control — the Measure panel below reads the Affiliate
          metrics floor over this window. Persisted in the URL (survives refresh). */}
      <DateRangeControls {...dr.controlProps} brands={brands} showBrand={false} showCompare={false} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Campaigns" value={intOrDash(totalCampaigns)} hint="record_type=campaign" />
        <StatTile label="Creators sourced" value={intOrDash(totalSourced)} hint="linked across campaigns" />
        <StatTile label="Active creators" value={intOrDash(totalActive)} hint="status = active" />
        <StatTile
          label="Follower reach"
          value={totalReach == null ? EMPTY : intOrDash(totalReach)}
          hint="Σ known follower counts"
        />
      </div>

      {/* Create campaign */}
      <SectionCard title="New campaign" className="mb-6">
        <form action={createCampaign} className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="title" required placeholder="Campaign name" className={`${inputCls} sm:col-span-2`} />
            <select name="brand_id" defaultValue="" aria-label="Brand" className={inputCls}>
              <option value="">Brand — optional</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <label className="text-xs text-ink-muted">
              Start date
              <input name="start_date" type="date" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <label className="text-xs text-ink-muted">
              End date
              <input name="end_date" type="date" className={`mt-1 w-full ${inputCls}`} />
            </label>
          </div>

          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Fit criteria
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              <input name="fit_min_followers" type="number" min="0" placeholder="Min followers" className={inputCls} />
              <input name="fit_category" placeholder="Category" className={inputCls} />
              <input name="fit_platform" placeholder="Platform" className={inputCls} />
              <input name="fit_region" placeholder="Region" className={inputCls} />
              <input name="fit_notes" placeholder="Notes / other fit criteria" className={`${inputCls} sm:col-span-4`} />
            </div>
          </div>

          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              KPI target (targets — the tracker shows live actuals separately)
            </p>
            <div className="grid gap-3 sm:grid-cols-5">
              <input name="kpi_sourced" type="number" min="0" placeholder="# sourced" className={inputCls} />
              <input name="kpi_qualified" type="number" min="0" placeholder="# qualified" className={inputCls} />
              <input name="kpi_active" type="number" min="0" placeholder="# active" className={inputCls} />
              <input name="kpi_reach" type="number" min="0" placeholder="Reach" className={inputCls} />
              <input name="kpi_gmv" type="number" min="0" step="0.01" placeholder="GMV target" className={inputCls} />
            </div>
          </div>

          <div>
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Create campaign
            </button>
          </div>
        </form>
      </SectionCard>

      {/* Campaign list with live KPI roll-up */}
      <SectionCard title="Campaigns" className="mb-6" bodyClassName="p-0">
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-ink-muted">
            No campaigns yet. Create one above to start sourcing creators.
          </p>
        ) : (
          <TableShell
            columns={["Campaign", "Brand", "Status", "Sourced", "Qualified", "Active", "Reach", "Attr. GMV", ""]}
          >
            {rows.map(({ c, kpi }) => (
              <tr key={c.id} className={rowClass}>
                <td className="p-3">
                  <Link href={`/affiliate/campaigns/${c.id}`} className="font-medium text-ink hover:text-teal-300">
                    {c.title ?? "Untitled campaign"}
                  </Link>
                </td>
                <td className="p-3 text-ink-muted">{brandName(c.brand_id)}</td>
                <td className="p-3">
                  <Badge tone="muted">{c.status ?? "draft"}</Badge>
                </td>
                <td className="p-3 font-mono text-ink">{intOrDash(kpi.sourced)}</td>
                <td className="p-3 font-mono text-ink">{intOrDash(kpi.qualified)}</td>
                <td className="p-3 font-mono text-ink">{intOrDash(kpi.active)}</td>
                <td className="p-3 font-mono text-ink">{kpi.reach == null ? EMPTY : intOrDash(kpi.reach)}</td>
                <td className="p-3 font-mono text-ink">{pesoOrDash(kpi.gmv)}</td>
                <td className="p-3">
                  <Link href={`/affiliate/campaigns/${c.id}`} className="text-xs text-teal-300 hover:underline">
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>

      {/* Marketing campaigns · type = affiliate — the SAME public.campaigns table
          the Commerce area manages, surfaced here filtered to the affiliate kind.
          Distinct from the op_records campaign list above; managed on /campaigns. */}
      <SectionCard
        title={`Marketing campaigns · ${CAMPAIGN_TYPE_LABEL.affiliate}`}
        action={
          <Link href="/campaigns?type=affiliate" className="text-xs text-teal-300 hover:underline">
            Manage in Campaigns →
          </Link>
        }
        className="mb-6"
        bodyClassName="p-0"
      >
        {mktCampaigns.length === 0 ? (
          <p className="p-5 text-sm text-ink-muted">
            No affiliate-type marketing campaigns yet. Create one in{" "}
            <Link href="/campaigns?type=affiliate" className="text-teal-300 hover:underline">
              Campaigns
            </Link>{" "}
            (set Type = Affiliate), then link creators to it from the Add-creator form.
          </p>
        ) : (
          <TableShell columns={["Campaign", "Brand", "Status", "Dates"]}>
            {mktCampaigns.map((c) => (
              <tr key={c.id} className={rowClass}>
                <td className="p-3 text-ink">{c.name}</td>
                <td className="p-3 text-ink-muted">{brandName(c.brand_id)}</td>
                <td className="p-3">
                  <Badge tone="muted">{c.status ?? "planning"}</Badge>
                </td>
                <td className="p-3 font-mono text-xs text-ink-muted">
                  {c.start_date ?? EMPTY}
                  {c.end_date ? ` → ${c.end_date}` : ""}
                </td>
              </tr>
            ))}
          </TableShell>
        )}
        <p className="border-t border-charcoal-700/60 p-3 text-[11px] text-ink-dim">
          These are <span className="text-ink">public.campaigns</span> rows with type =
          affiliate — the same table Commerce uses, filtered by type. The op_records campaign
          list above is separate.
        </p>
      </SectionCard>

      {/* Measure panel — Affiliate metrics floor */}
      <SectionCard
        title="Measure"
        action={<span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">{dr.rangeLabel}</span>}
        bodyClassName="p-0"
      >
        {measure.length === 0 ? (
          <p className="p-5 text-sm text-ink-muted">No Affiliate metrics are defined in the catalog.</p>
        ) : (
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {measure.map((m) => (
              <div key={m.metric_key} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-4">
                <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{m.label}</p>
                <p className="mt-1 text-xl font-bold text-ink">{formatMetric(m.value, m.unit)}</p>
              </div>
            ))}
          </div>
        )}
        <p className="border-t border-charcoal-700/60 p-3 text-[11px] text-ink-dim">
          Freshest value per metric from the Affiliate metrics floor. Missing values read “—”, never a
          fabricated 0. Encode values in Quick Entry / Data Analytics.
        </p>
      </SectionCard>
    </AppShell>
  );
}
