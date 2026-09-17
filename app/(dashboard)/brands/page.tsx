import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, Badge, type BadgeTone, HelpHint } from "@/components/ui";
import { requireRole, requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import type { SessionProfile } from "@/lib/auth/session";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { LiveHeader } from "@/components/metrics/LiveHeader";
import { BrandSwitcher } from "@/components/metrics/BrandSwitcher";
import { customWindow, manilaStamp } from "@/lib/metrics/windows";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import {
  fetchCommerceRows,
  aggregate,
  SALES_PLATFORMS,
  AD_PLATFORMS,
  platformLabel,
  type GmvAgg,
} from "@/lib/metrics/gmv";
import { getDataFreshness } from "@/lib/metrics/freshness";
import { peso as fmtPeso, intOrDash as fmtIntOrDash, pesoOrDash, ratioOrDash } from "@/lib/metrics/format";
import {
  getLiveLatestByBrand,
  fmtStatDate,
  type BrandDay,
} from "@/lib/metrics/tiktok-live";

// Clients / Brands. The people we run for — add a client, set which
// marketplaces they sell on, and manage their status (active/paused/archived).
//
// The Brand Portfolio detail below each client enriches every brand with three
// live dimensions: Sales Source and Traffic Source (where the GMV / visitors
// actually come from, per marketplace) and Marketing Initiatives (the campaigns
// and promos running against the brand). These are honest by construction —
// nothing is seeded, so a brand with no data recorded reads as an explicit
// empty state until a real entry is added.

// Commerce Ops READS the client relationship — these fields are owned + edited
// only in Business Development (/clients). We select them read-only for the
// Linked Account reference card; none of them are editable on this page.
type Brand = {
  id: string;
  name: string;
  legal_name: string | null;
  category: string | null;
  platform_focus: string[] | null;
  gmv_share: number | null;
  status: string;
  account_tier: string | null;
  onboarding_status: string;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  created_at: string;
};

// Sales & Traffic breakdown rows share one table, split by `dimension`. Numeric
// fields are nullable on our side: we insert null (not 0) when a value is left
// blank so an unknown number never renders as a fabricated zero.
type SourceBreakdown = {
  id: string;
  brand_id: string;
  platform: string | null;
  period_start: string | null;
  period_end: string | null;
  dimension: string; // 'sales' | 'traffic'
  source: string;
  gmv: number | null;
  orders: number | null;
  units: number | null;
  visitors: number | null;
  share: number | null;
  origin: string | null;
};

type Initiative = {
  id: string;
  brand_id: string;
  platform: string | null;
  type: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  note: string | null;
  archived_at: string | null;
};

// Lifecycle status labels/tones — read-only here (owned in Business Development).
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};
const STATUS_TONE: Record<string, BadgeTone> = {
  active: "teal",
  paused: "amber",
  archived: "muted",
};

const PLATFORMS = [
  { value: "tiktok", label: "TikTok Shop" },
  { value: "shopee", label: "Shopee" },
  { value: "lazada", label: "Lazada" },
] as const;
const PLATFORM_LABEL: Record<string, string> = {
  tiktok: "TikTok Shop",
  shopee: "Shopee",
  lazada: "Lazada",
};

// Marketing initiative vocabularies. Stored strings are fixed; labels are
// prettied for display. No CHECK constraint backs these — the UI is the guard.
const INITIATIVE_TYPES = [
  { value: "campaign", label: "Campaign" },
  { value: "promo", label: "Promotion" },
  { value: "ads", label: "Paid Ads" },
  { value: "live", label: "Live Selling" },
  { value: "affiliate", label: "Affiliate" },
  { value: "content", label: "Content" },
  { value: "other", label: "Other" },
] as const;
const INITIATIVE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  INITIATIVE_TYPES.map((t) => [t.value, t.label])
);
const INITIATIVE_STATUSES = [
  { value: "planned", label: "Planned", tone: "violet" as BadgeTone },
  { value: "active", label: "Active", tone: "teal" as BadgeTone },
  { value: "paused", label: "Paused", tone: "amber" as BadgeTone },
  { value: "completed", label: "Completed", tone: "muted" as BadgeTone },
] as const;
const INITIATIVE_STATUS_LABEL: Record<string, string> = Object.fromEntries(
  INITIATIVE_STATUSES.map((s) => [s.value, s.label])
);
const INITIATIVE_STATUS_TONE: Record<string, BadgeTone> = Object.fromEntries(
  INITIATIVE_STATUSES.map((s) => [s.value, s.tone])
);

// A delete filter is awaitable and chainable — `.eq(...).eq(...)` narrows the
// rows, and the whole thing resolves to { error }. Recursive interface so
// multiple .eq() calls type-check (used to scope deletes to manual rows).
interface DeleteFilter extends Promise<{ error: unknown }> {
  eq: (c: string, val: string) => DeleteFilter;
}
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
    delete: () => DeleteFilter;
  };
};

// Shared input chrome for the compact portfolio add forms.
const fieldCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-xs text-ink";

// NOTE: Client relationship CRUD (create / edit / delete a client, and every
// relationship field — legal name, contacts, tier, onboarding status, lifecycle
// status) lives ONLY in Business Development (/clients). Commerce Ops is a reader
// here: it shows a read-only Linked Account card and deep-links to the owner.
// The only mutations on this page are the e-comm team's OWN operational data
// below (sources & initiatives), which stay team-writable by design.

// Parse an optional numeric form field: blank stays null (unknown), never 0.
// This is the honesty guard — a left-blank GMV/orders/visitors reads as "—",
// not as a fabricated zero.
function optNum(formData: FormData, key: string): number | null {
  const raw = String(formData.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Add a Sales or Traffic source breakdown row for a brand. One action serves
// both dimensions; the irrelevant metrics for the chosen dimension are stored
// as null. Any org member can write (matches the bsb_write RLS policy, now open
// to org members). Manual rows are stamped origin='manual' so the UI keeps them
// team-editable while auto rows (origin='api', written by the shop sync) stay
// read-only.
async function addBrandSource(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };
  const brand_id = String(formData.get("brand_id") ?? "");
  const dimension = String(formData.get("dimension") ?? "");
  const source = String(formData.get("source") ?? "").trim();
  if (!brand_id || (dimension !== "sales" && dimension !== "traffic") || !source) return;
  const isSales = dimension === "sales";
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("brand_source_breakdown").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    brand_id,
    dimension,
    source,
    platform: String(formData.get("platform") ?? "") || null,
    gmv: isSales ? optNum(formData, "gmv") : null,
    orders: isSales ? optNum(formData, "orders") : null,
    units: isSales ? optNum(formData, "units") : null,
    visitors: isSales ? null : optNum(formData, "visitors"),
    share: optNum(formData, "share"),
    origin: "manual",
  });
  revalidatePath("/brands");
}

async function deleteBrandSource(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  // Only manual rows are deletable — auto (origin='api') rows are owned by the
  // shop sync. The eq on origin makes the guard authoritative server-side, so a
  // crafted request can't remove a synced row even though the UI hides its button.
  await (supabase as unknown as DbShim)
    .from("brand_source_breakdown")
    .delete()
    .eq("id", id)
    .eq("origin", "manual");
  revalidatePath("/brands");
}

// Add a Marketing Initiative for a brand (any org member — matches bi_write,
// now open to org members).
async function addBrandInitiative(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };
  const brand_id = String(formData.get("brand_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!brand_id || !name || !type) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("brand_initiatives").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    brand_id,
    name,
    type,
    platform: String(formData.get("platform") ?? "") || null,
    status: String(formData.get("status") ?? "planned") || "planned",
    start_date: String(formData.get("start_date") ?? "") || null,
    end_date: String(formData.get("end_date") ?? "") || null,
    note: String(formData.get("note") ?? "").trim() || null,
  });
  revalidatePath("/brands");
}

async function deleteBrandInitiative(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("brand_initiatives").delete().eq("id", id);
  revalidatePath("/brands");
}

// --- Display formatters ----------------------------------------------------
function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}
function intOrDash(n: number | null): string {
  return n != null ? new Intl.NumberFormat("en-US").format(Number(n)) : "—";
}
function pctOrDash(n: number | null): string {
  return n != null ? `${Number(n)}%` : "—";
}
function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  return `${start ?? "…"} → ${end ?? "…"}`;
}

// A source/traffic row is one of two kinds, told apart by `origin`:
//   • 'api'   — written by the shop API sync. Read-only here, refreshed on the
//               next sync. Labeled "Auto · from <platform> sync".
//   • 'manual' (or null legacy) — entered by the team. Editable / deletable.
// Rendering the origin honestly is what lets auto and manual coexist in one
// list without pretending a synced number was hand-entered (or vice-versa).
function isAutoSource(origin: string | null): boolean {
  return origin === "api";
}
function OriginTag({ origin, platform }: { origin: string | null; platform: string | null }) {
  if (isAutoSource(origin)) {
    const src = platform ? PLATFORM_LABEL[platform] ?? platform : "shop";
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-charcoal-800 px-2 py-0.5 text-[10px] text-teal-300 ring-1 ring-teal-500/30"
        title={`Synced from ${src} — refreshed by the sync, read-only here.`}
      >
        <span aria-hidden>⟳</span> Auto · from {src} sync
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-charcoal-800 px-2 py-0.5 text-[10px] text-ink-muted ring-1 ring-charcoal-600"
      title="Added by the team — editable and removable."
    >
      Manual
    </span>
  );
}

// ── Part 4: per-brand, per-platform performance blocks (windowed) ────────────
// Every figure runs through the shared aggregation helper, so a brand's totals
// here reconcile with the Command Center and Reports for the same window.
// Divide-by-zero is guarded in the helper (AOV, ROAS, return_rate → null → "—").

function PlatformStatCell({ children, tone = "text-ink" }: { children: React.ReactNode; tone?: string }) {
  return <td className={`px-3 py-2 font-mono text-xs ${tone}`}>{children}</td>;
}

// SALES BY PLATFORM — tiktok_shop | shopee | lazada | other.
function SalesByPlatform({ agg, windowLabel }: { agg: GmvAgg; windowLabel: string }) {
  const rows = agg.byPlatform.filter((p) => (SALES_PLATFORMS as string[]).includes(p.platform));
  return (
    <div>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
        Sales by platform <span className="text-ink-dim">· {windowLabel}</span>
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-muted">No sales recorded for this window yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-charcoal-700 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                <th className="px-3 py-1.5">Platform</th>
                <th className="px-3 py-1.5">GMV</th>
                <th className="px-3 py-1.5">Units</th>
                <th className="px-3 py-1.5">Orders</th>
                <th className="px-3 py-1.5">AOV</th>
                <th className="px-3 py-1.5">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.platform} className="border-b border-charcoal-700/50">
                  <td className="px-3 py-2 text-xs text-ink">{platformLabel(p.platform)}</td>
                  <PlatformStatCell tone="text-gold-400">{pesoOrDash(p.gmv, agg.currency)}</PlatformStatCell>
                  <PlatformStatCell>{fmtIntOrDash(p.units)}</PlatformStatCell>
                  <PlatformStatCell>{fmtIntOrDash(p.orders)}</PlatformStatCell>
                  <PlatformStatCell>{p.aov != null ? pesoOrDash(p.aov, agg.currency) : "—"}</PlatformStatCell>
                  <PlatformStatCell tone="text-teal-300">
                    {p.sharePct != null ? `${Math.round(p.sharePct)}%` : "—"}
                  </PlatformStatCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ADS BY PLATFORM — meta_ads | tiktok_ads | google_ads (separate from sales).
function AdsByPlatform({ agg, windowLabel }: { agg: GmvAgg; windowLabel: string }) {
  const rows = agg.byPlatform.filter((p) => (AD_PLATFORMS as string[]).includes(p.platform));
  return (
    <div className="border-t border-charcoal-700/60 pt-5">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
        Ads by platform <span className="text-ink-dim">· {windowLabel}</span>
      </p>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-muted">No ad spend recorded for this window yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-charcoal-700 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                <th className="px-3 py-1.5">Platform</th>
                <th className="px-3 py-1.5">Ad spend</th>
                <th className="px-3 py-1.5">Ad revenue</th>
                <th className="px-3 py-1.5">ROAS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.platform} className="border-b border-charcoal-700/50">
                  <td className="px-3 py-2 text-xs text-ink">{platformLabel(p.platform)}</td>
                  <PlatformStatCell>{pesoOrDash(p.adSpend, agg.currency)}</PlatformStatCell>
                  <PlatformStatCell>{pesoOrDash(p.adRevenue, agg.currency)}</PlatformStatCell>
                  <PlatformStatCell tone="text-green-400">{ratioOrDash(p.roas)}</PlatformStatCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// BRAND TOTALS — across sales platforms, with guarded rates.
function BrandTotals({ agg }: { agg: GmvAgg }) {
  const cells: { label: string; value: React.ReactNode; tone?: string }[] = [
    { label: "GMV", value: agg.hasData ? fmtPeso(agg.gmv, agg.currency) : "—", tone: "text-gold-400" },
    { label: "Orders", value: fmtIntOrDash(agg.orders) },
    { label: "Units", value: fmtIntOrDash(agg.units) },
    { label: "Returns", value: fmtIntOrDash(agg.returns) },
    { label: "Return rate", value: agg.returnRate != null ? `${(agg.returnRate * 100).toFixed(1)}%` : "—" },
    { label: "Ful. errors", value: fmtIntOrDash(agg.fulfillmentErrors), tone: "text-gold-400" },
  ];
  return (
    <div className="border-t border-charcoal-700/60 pt-5">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Brand totals</p>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-2">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{c.label}</p>
            <p className={`mt-0.5 font-mono text-xs ${c.tone ?? "text-ink"}`}>{c.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// LIVE TIKTOK SHOP — the auto-metrics header for a brand card. Reads the latest
// synced day from tiktok_shop_performance (no manual entry) and stamps the day it
// is "as of". Renders an honest empty state when nothing has synced for the brand.
function convPctLive(v: number | null): string {
  if (v == null) return "—";
  return `${(Math.round(v * 100 * 100) / 100).toFixed(2)}%`;
}
function LiveTikTok({ latest }: { latest: BrandDay | undefined }) {
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
          Live TikTok Shop
          <span className="rounded-full border border-teal-500/40 bg-teal-500/10 px-1.5 py-0.5 text-[9px] text-teal-300">
            auto
          </span>
        </p>
        {latest && (
          <span className="font-mono text-[10px] text-ink-dim">
            as of {fmtStatDate(latest.statDate)} · {latest.source}
          </span>
        )}
      </div>
      {latest ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {[
            { label: "GMV", value: peso(latest.gmv), tone: "text-gold-400" },
            { label: "Orders", value: intOrDash(latest.orders) },
            { label: "Units", value: intOrDash(latest.units) },
            { label: "Visitors", value: intOrDash(latest.visitors) },
            { label: "Conv.", value: convPctLive(latest.conversionRate), tone: "text-teal-300" },
          ].map((c) => (
            <div key={c.label} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-2">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{c.label}</p>
              <p className={`mt-0.5 font-mono text-xs ${c.tone ?? "text-ink"}`}>{c.value}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">
          No synced TikTok Shop data yet — figures auto-populate here once the daily sync lands a day
          for this brand. Manual entry below stays as a fallback.
        </p>
      )}
    </div>
  );
}

// ── The single, brand-switched commerce dashboard ───────────────────────────
// One brand's full commerce view, rendered from the shared section components
// and server actions above — nothing is re-implemented here. The Clients page
// hosts exactly one of these at a time (the brand chosen in the dropdown), so
// there is one dashboard for every brand rather than a page per brand.
function BrandDashboard({
  brand,
  sales,
  traffic,
  inits,
  agg,
  live,
  windowLabel,
  canManageDetail,
  profile,
  archived,
  dateParams,
}: {
  brand: Brand;
  sales: SourceBreakdown[];
  traffic: SourceBreakdown[];
  inits: Initiative[];
  agg: GmvAgg;
  live: BrandDay | undefined;
  windowLabel: string;
  canManageDetail: boolean;
  profile: SessionProfile;
  archived: boolean;
  dateParams: Record<string, string>;
}) {
  const platformLabel = (p: string | null) => (p ? PLATFORM_LABEL[p] ?? p : null);
  return (
    <SectionCard
      title={brand.name}
      action={
        <Badge tone={STATUS_TONE[brand.status] ?? "teal"}>
          {STATUS_LABEL[brand.status] ?? brand.status}
        </Badge>
      }
    >
      <div className="space-y-5">
        {/* 1) Auto-metrics: live TikTok Shop, no manual entry */}
        <LiveTikTok latest={live} />
        {/* 2) Sales by platform for the resolved window */}
        <div className="border-t border-charcoal-700/60 pt-5">
          <SalesByPlatform agg={agg} windowLabel={windowLabel} />
        </div>
        {/* 3) Ads by platform */}
        <AdsByPlatform agg={agg} windowLabel={windowLabel} />
        {/* 4) Brand totals */}
        <BrandTotals agg={agg} />

        {/* 5) Sales Source — hybrid: auto rows from the shop sync (read-only)
               and manual rows the team adds, each labeled by origin */}
        <div className="border-t border-charcoal-700/60 pt-5">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Sales Source
          </p>
          {sales.length === 0 ? (
            <p className="text-xs text-ink-muted">No sales sources recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {sales.map((s) => (
                <li key={s.id} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-ink">{s.source}</span>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {platformLabel(s.platform) && (
                        <span className="rounded-full bg-charcoal-800 px-2 py-0.5 text-[10px] text-teal-300 ring-1 ring-teal-500/30">
                          {platformLabel(s.platform)}
                        </span>
                      )}
                      <OriginTag origin={s.origin} platform={s.platform} />
                      {canManageDetail && !isAutoSource(s.origin) && (
                        <form action={deleteBrandSource}>
                          <input type="hidden" name="id" value={s.id} />
                          <button type="submit" aria-label="Delete sales source" className="rounded-md bg-charcoal-800 px-2 py-0.5 text-[10px] text-red-300 hover:bg-charcoal-700">
                            Remove
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
                    <span>GMV {s.gmv != null ? peso(Number(s.gmv)) : "—"}</span>
                    <span>Orders {intOrDash(s.orders)}</span>
                    <span>Units {intOrDash(s.units)}</span>
                    <span>Share {pctOrDash(s.share)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canManageDetail && (
            <form action={addBrandSource} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <input type="hidden" name="brand_id" value={brand.id} />
              <input type="hidden" name="dimension" value="sales" />
              <input name="source" required placeholder="Source (e.g. Live, Organic)" className={`${fieldCls} col-span-2 sm:col-span-2`} />
              <select name="platform" defaultValue="" className={fieldCls}>
                <option value="">Platform…</option>
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <input name="gmv" type="number" step="any" placeholder="GMV" className={fieldCls} />
              <input name="orders" type="number" placeholder="Orders" className={fieldCls} />
              <input name="units" type="number" placeholder="Units" className={fieldCls} />
              <input name="share" type="number" step="any" placeholder="Share %" className={fieldCls} />
              <button type="submit" className="col-span-2 rounded-md bg-charcoal-800 px-2 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:col-span-1">
                Add source
              </button>
            </form>
          )}
        </div>

        {/* 6) Traffic Source */}
        <div className="border-t border-charcoal-700/60 pt-5">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Traffic Source
          </p>
          {traffic.length === 0 ? (
            <p className="text-xs text-ink-muted">No traffic sources recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {traffic.map((s) => (
                <li key={s.id} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-ink">{s.source}</span>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {platformLabel(s.platform) && (
                        <span className="rounded-full bg-charcoal-800 px-2 py-0.5 text-[10px] text-teal-300 ring-1 ring-teal-500/30">
                          {platformLabel(s.platform)}
                        </span>
                      )}
                      <OriginTag origin={s.origin} platform={s.platform} />
                      {canManageDetail && !isAutoSource(s.origin) && (
                        <form action={deleteBrandSource}>
                          <input type="hidden" name="id" value={s.id} />
                          <button type="submit" aria-label="Delete traffic source" className="rounded-md bg-charcoal-800 px-2 py-0.5 text-[10px] text-red-300 hover:bg-charcoal-700">
                            Remove
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
                    <span>Visitors {intOrDash(s.visitors)}</span>
                    <span>Share {pctOrDash(s.share)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canManageDetail && (
            <form action={addBrandSource} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <input type="hidden" name="brand_id" value={brand.id} />
              <input type="hidden" name="dimension" value="traffic" />
              <input name="source" required placeholder="Source (e.g. Search, Referral)" className={`${fieldCls} col-span-2 sm:col-span-2`} />
              <select name="platform" defaultValue="" className={fieldCls}>
                <option value="">Platform…</option>
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <input name="visitors" type="number" placeholder="Visitors" className={fieldCls} />
              <input name="share" type="number" step="any" placeholder="Share %" className={fieldCls} />
              <button type="submit" className="col-span-2 rounded-md bg-charcoal-800 px-2 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:col-span-1">
                Add source
              </button>
            </form>
          )}
        </div>

        {/* 7) Marketing Initiatives */}
        <div className="border-t border-charcoal-700/60 pt-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Marketing Initiatives
            </p>
            <ArchivedToggle
              basePath="/brands"
              archived={archived}
              params={{ brand: brand.id, ...dateParams }}
            />
          </div>
          {inits.length === 0 ? (
            <p className="text-xs text-ink-muted">
              {archived
                ? "No archived initiatives."
                : "No marketing initiatives recorded yet."}
            </p>
          ) : (
            <ul className="space-y-2">
              {inits.map((i) => (
                <li key={i.id} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-ink">{i.name}</span>
                    <div className="flex items-center gap-2">
                      <Badge tone={INITIATIVE_STATUS_TONE[i.status ?? "planned"] ?? "muted"}>
                        {INITIATIVE_STATUS_LABEL[i.status ?? "planned"] ?? i.status ?? "—"}
                      </Badge>
                      {canManageDetail && (
                        <form action={deleteBrandInitiative}>
                          <input type="hidden" name="id" value={i.id} />
                          <button type="submit" aria-label="Delete initiative" className="rounded-md bg-charcoal-800 px-2 py-0.5 text-[10px] text-red-300 hover:bg-charcoal-700">
                            Remove
                          </button>
                        </form>
                      )}
                      <RowActions
                        {...rowActionProps(
                          "brand_initiatives",
                          i as unknown as Record<string, unknown>,
                          profile
                        )}
                      />
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
                    <span className="font-mono uppercase tracking-wider">
                      {INITIATIVE_TYPE_LABEL[i.type] ?? i.type}
                    </span>
                    {platformLabel(i.platform) && <span>· {platformLabel(i.platform)}</span>}
                    {dateRange(i.start_date, i.end_date) && (
                      <span className="font-mono">{dateRange(i.start_date, i.end_date)}</span>
                    )}
                  </div>
                  {i.note && <p className="mt-1 text-xs text-ink-muted">{i.note}</p>}
                </li>
              ))}
            </ul>
          )}
          {canManageDetail && (
            <form action={addBrandInitiative} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <input type="hidden" name="brand_id" value={brand.id} />
              <input name="name" required placeholder="Initiative name" className={`${fieldCls} col-span-2 sm:col-span-3`} />
              <select name="type" required defaultValue="" className={fieldCls}>
                <option value="" disabled>Type…</option>
                {INITIATIVE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <select name="status" defaultValue="planned" className={fieldCls}>
                {INITIATIVE_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <select name="platform" defaultValue="" className={fieldCls}>
                <option value="">Platform…</option>
                {PLATFORMS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <label className="col-span-2 text-[10px] text-ink-muted sm:col-span-1">
                Start
                <input name="start_date" type="date" className={`${fieldCls} mt-0.5 w-full`} />
              </label>
              <label className="col-span-2 text-[10px] text-ink-muted sm:col-span-1">
                End
                <input name="end_date" type="date" className={`${fieldCls} mt-0.5 w-full`} />
              </label>
              <input name="note" placeholder="Note (optional)" className={`${fieldCls} col-span-2 sm:col-span-1`} />
              <button type="submit" className="col-span-2 rounded-md bg-charcoal-800 px-2 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:col-span-3">
                Add initiative
              </button>
            </form>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ── Linked Account — the READ-ONLY reference to the client relationship ──────
// Commerce Ops never owns or edits client facts. This card is a live reference
// to the canonical `brands` record (read via the selected brand) plus a
// deep-link to the owner (Business Development). No inputs, no duplicate editable
// columns — the moment BizDev edits a field, it shows here on the next load.
const TIER_LABEL: Record<string, string> = {
  strategic: "Strategic",
  growth: "Growth",
  standard: "Standard",
};
const ONBOARDING_LABEL: Record<string, string> = {
  prospect: "Prospect",
  onboarding: "Onboarding",
  active: "Active",
  at_risk: "At risk",
  offboarded: "Offboarded",
};

function LinkedAccountCard({ brand }: { brand: Brand }) {
  const rows: { label: string; value: string }[] = [
    { label: "Company / legal name", value: brand.legal_name ?? brand.name },
    { label: "Account tier", value: brand.account_tier ? TIER_LABEL[brand.account_tier] ?? brand.account_tier : "—" },
    { label: "Onboarding", value: ONBOARDING_LABEL[brand.onboarding_status] ?? brand.onboarding_status },
    {
      label: "Primary contact",
      value: brand.primary_contact_name
        ? brand.primary_contact_email
          ? `${brand.primary_contact_name} · ${brand.primary_contact_email}`
          : brand.primary_contact_name
        : "—",
    },
  ];
  return (
    <div className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900/60 p-5 shadow-elevate">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Linked account</p>
          <span className="rounded-full border border-charcoal-600 bg-charcoal-800 px-2 py-0.5 text-[9px] uppercase tracking-wider text-ink-dim">
            read-only
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[brand.status] ?? "teal"}>{STATUS_LABEL[brand.status] ?? brand.status}</Badge>
          <Link href={`/clients?brand=${brand.id}`} className="text-xs text-teal-400 hover:text-teal-300">
            View in Business Development →
          </Link>
        </div>
      </div>
      <p className="mb-3 text-base font-semibold text-ink">{brand.name}</p>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{r.label}</dt>
            <dd className="mt-0.5 text-sm text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[11px] text-ink-muted">
        Client relationship fields are owned by Business Development — edit them there; they appear
        here read-only.
      </p>
    </div>
  );
}

export default async function BrandsPage({ searchParams }: { searchParams?: DateRangeSearchParams & { brand?: string; archived?: string } }) {
  // Commerce operating page — department-scoped to E-Commerce Ops + Warehouse &
  // Fulfillment (leadership bypasses). RLS still scopes rows underneath.
  const profile = await requireModule("/brands");
  // The portfolio dimensions (sources + initiatives) are the e-commerce team's
  // day-to-day workspace: any org member may add/remove manual rows. This
  // matches the RLS policies on brand_source_breakdown / brand_initiatives,
  // which were opened to org members. Only manual rows are editable — rows the
  // shop API sync wrote (origin='api') stay read-only regardless of role.
  const canManageDetail = true;
  const supabase = createServerSupabaseClient();
  // Shared date-range control (defaults to MTD) — the same Today/…/Custom picker
  // as every other dashboard, replacing the older WindowSwitcher. Every per-brand
  // figure re-slices to the selected window through the shared aggregation.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const win = customWindow(dr.range.start, dr.range.end, dr.rangeLabel);
  // Preserve the active window on the archived-view toggle links below.
  const dateParams: Record<string, string> =
    dr.preset === "custom"
      ? { preset: "custom", period_start: dr.range.start, period_end: dr.range.end }
      : { preset: dr.preset };
  const nowIso = new Date().toISOString();
  // Active initiatives by default; the Archived view flips this list. Archived
  // clients are always dropped from the brand switcher here.
  const archived = searchParams?.archived === "1";
  const initSelect = supabase
    .from("brand_initiatives")
    .select("id, brand_id, platform, type, name, start_date, end_date, status, note, archived_at");
  const initQuery = (archived
    ? initSelect.not("archived_at", "is", null)
    : initSelect.is("archived_at", null)
  ).order("created_at", { ascending: false });
  const [brandRes, sourceRes, initRes, bpmRows, freshness, liveByBrand] = await Promise.all([
    supabase
      .from("brands")
      .select(
        "id, name, legal_name, category, platform_focus, gmv_share, status, account_tier, onboarding_status, primary_contact_name, primary_contact_email, created_at"
      )
      .is("archived_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("brand_source_breakdown")
      .select(
        "id, brand_id, platform, period_start, period_end, dimension, source, gmv, orders, units, visitors, share, origin"
      )
      .order("created_at", { ascending: false }),
    initQuery,
    fetchCommerceRows(supabase),
    getDataFreshness(supabase),
    // Latest live TikTok Shop day per brand — auto-populated from the synced
    // landing table so the portfolio fills itself in without manual entry.
    getLiveLatestByBrand(supabase),
  ]);
  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const sources = (sourceRes.data ?? []) as unknown as SourceBreakdown[];
  const initiatives = (initRes.data ?? []) as unknown as Initiative[];
  // Per-brand aggregate for the resolved window (one collapse pass over rows).
  const aggFor = (brandId: string): GmvAgg => aggregate(bpmRows, win, { brandId });

  const salesFor = (brandId: string) =>
    sources.filter((s) => s.brand_id === brandId && s.dimension === "sales");
  const trafficFor = (brandId: string) =>
    sources.filter((s) => s.brand_id === brandId && s.dimension === "traffic");
  const initiativesFor = (brandId: string) =>
    initiatives.filter((i) => i.brand_id === brandId);

  // The dashboard shows one brand at a time. Default to the client named in the
  // ?brand= param when it is a real org brand, otherwise the most recent client.
  const selectedBrand =
    brands.find((b) => b.id === searchParams?.brand) ?? brands[0] ?? null;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Commerce Ops", "Clients"]} profile={profile}>
      <PageHeader
        title={<>Clients — Commerce Ops <HelpHint id="commerce" /></>}
        subtitle="Operational workspace for every client — live TikTok Shop, platform sales & ads, brand totals, and the team's own sources & initiatives. The client relationship itself is owned by Business Development and shown here read-only."
      />

      {/* Shared date-range control — replaces the older WindowSwitcher so Clients
          matches every other dashboard. Brand is chosen by the switcher below and
          Compare isn't wired here, so the picker hides both levers. */}
      <DateRangeControls {...dr.controlProps} brands={[]} showBrand={false} showCompare={false} />

      {/* Controls — the brand dropdown drives the whole dashboard; the freshness
          stamp applies to the selected brand's figures. */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        {brands.length > 0 && selectedBrand ? (
          <BrandSwitcher
            brands={brands.map((b) => ({ id: b.id, name: b.name }))}
            current={selectedBrand.id}
          />
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <LiveHeader
            nowIso={nowIso}
            freshness={manilaStamp(freshness.asOf)}
            freshnessSource={freshness.source}
            progress={null}
            pace={null}
          />
        </div>
      </div>

      {/* Linked Account — read-only reference to the BizDev-owned client record. */}
      {selectedBrand && <LinkedAccountCard brand={selectedBrand} />}

      {/* The single, brand-switched commerce dashboard. Selecting a brand in the
          dropdown swaps all operational sections below to that brand. */}
      {selectedBrand ? (
        <BrandDashboard
          brand={selectedBrand}
          sales={salesFor(selectedBrand.id)}
          traffic={trafficFor(selectedBrand.id)}
          inits={initiativesFor(selectedBrand.id)}
          agg={aggFor(selectedBrand.id)}
          live={liveByBrand.get(selectedBrand.id)}
          windowLabel={win.label}
          canManageDetail={canManageDetail}
          profile={profile}
          archived={archived}
          dateParams={dateParams}
        />
      ) : (
        <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-6 text-sm text-ink-muted shadow-elevate">
          No clients yet — clients are created in{" "}
          <Link href="/clients" className="text-teal-400 hover:text-teal-300">
            Business Development
          </Link>
          .
        </p>
      )}
    </AppShell>
  );
}
