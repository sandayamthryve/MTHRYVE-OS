// lib/os/snapshot.ts — the ONE canonical, org-scoped read behind /api/os/snapshot.
//
// This is a PURE READ. It never writes and adds no schema: every figure is
// computed live from tables the OS already owns, through the CALLER's own
// RLS-scoped Supabase session, so `org_id = current_org_id()` (and the finance
// gate `current_user_role() in ('ceo','coo')`) remain the real boundary. This
// module is additive — it composes the SAME shared readers the existing surfaces
// use, so the numbers reconcile with Command Center / Reports / Finance to the
// peso rather than becoming a second, drifting source of truth.
//
// RANGE-AWARE: every commerce figure (company GMV/orders, the platform split, the
// per-brand rows and the Revenue Pulse) is computed for the SELECTED range that
// the caller passes — today / yesterday / 7d / 30d / mtd / qtd / ytd / custom. The
// range and the number always agree: a range with zero rows returns an HONEST NULL
// (the UI renders "—" + "no data for this range"), NEVER a fall-back to MTD or to
// another range's figure.
//
// GMV COMES FROM ONE SOURCE: tiktok_shop_performance (clean, mapped, API-sourced)
// via lib/metrics/tiktok-live. brand_platform_metrics is NOT read for GMV anywhere
// here — it is stale and missing FML & Alianna, and a later phase retires it. Both
// company GMV and brands[] GMV are summed from the SAME per-brand TikTok set, so
// `company == Σ brands` holds BY CONSTRUCTION (no drift between the two).
//
// Sources, one block at a time:
//   • company    → Σ over the per-brand tiktok_shop_performance set for the range.
//                  GMV is TikTok-only today; company.gmv_by_platform reports tiktok
//                  as the real figure and shopee/lazada as null (HONEST NULL —
//                  there is no clean live pipe for them yet; never the stale bpm
//                  figure).
//   • brands[]   → tiktok_shop_performance via lib/metrics/tiktok-live (the live
//                  per-brand commerce reader; the FML/Alianna brand_id mapping is
//                  already fixed upstream, so nothing here is unmapped).
//   • revenue_pulse → weekly TikTok GMV over the 12 ISO weeks ENDING at the range's
//                  end, from the SAME per-brand set (so the pulse respects the range
//                  selector and reconciles with company by construction).
//   • freshness  → max(stat_date) across the org's TikTok rows vs Manila today, so
//                  the UI can read "as of Jul 27" when the latest live day trails
//                  the calendar (e.g. an empty "Today").
//   • departments[] → departments + metrics_snapshots (the existing per-department
//                  health source; there is no metric_compartments table in this
//                  schema, so we read the snapshot the dashboards already use).
//   • clients[]  → brands (the canonical CLIENT record in this OS — Business Dev
//                  owns it on /clients) + metric_entries for the report status; its
//                  gmv is the SAME per-brand TikTok range figure as brands[].
//   • finance    → lib/finance/data.loadCashflow, and ONLY for ceo/coo; for every
//                  other role the whole block is null (defense in depth on top of
//                  the finance-table RLS + the Policy Registry gate).
//
// HONEST NULLS throughout: a metric with no underlying signal is null (the UI
// renders "—"), never a fabricated 0. A zero only ever means a real, measured 0.

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/database";
import {
  monthToDate,
  isoWeekManila,
  todayManila,
  customWindow,
  type ResolvedWindow,
} from "@/lib/metrics/windows";
import { getLiveDaysByBrand, type BrandDay } from "@/lib/metrics/tiktok-live";
import { loadCashflow } from "@/lib/finance/data";

type Client = ReturnType<typeof createServerSupabaseClient>;
// Read-only cast shim for the few reads loadCashflow needs behind an untyped
// `from` — the same shim the Command Center assembler uses. Never writes.
type Shim = { from: (t: string) => any };

const round = (n: number, d = 0): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

// Leadership === ceo | coo (there is no super-admin role in this schema). The
// finance block is populated for these roles ONLY.
function isLeadershipRole(role: UserRole | string | null | undefined): boolean {
  return role === "ceo" || role === "coo";
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Format a plain YYYY-MM-DD as "Jul 27" (no year, no timezone shift — stat_date is
// already a Manila calendar day). Used for the freshness "as of" stamp.
function shortDay(d: string | null | undefined): string | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const label = SHORT_MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${label} ${Number(m[3])}`;
}

// ── Public shapes ─────────────────────────────────────────────────────────────

// The window every commerce figure in the snapshot is scoped to. Echoed back so
// the UI can prove the range label and the number agree.
export interface SnapshotRange {
  key: string; // preset key: today|yesterday|last_7|last_30|mtd|qtd|ytd|custom
  start: string; // inclusive YYYY-MM-DD (Asia/Manila)
  end: string; // inclusive YYYY-MM-DD (Asia/Manila)
  label: string; // human label, e.g. "MTD", "Today", "2026-07-01 → 2026-07-15"
}

// How current the underlying TikTok data is: the latest stat_date the org has, vs
// Manila today. `is_stale` is true when the latest live day trails today — which is
// exactly when a "Today" range is legitimately empty.
export interface Freshness {
  max_stat_date: string | null; // e.g. "2026-07-27", null when no rows at all
  today: string; // Manila today, YYYY-MM-DD
  is_stale: boolean; // max_stat_date < today
  as_of_label: string | null; // e.g. "Jul 27", null when no rows at all
}

// GMV split by sales platform for the selected range. Only TikTok has a clean live
// per-brand source today, so tiktok carries the real figure and shopee/lazada are
// null (honest "—", never the stale brand_platform_metrics value).
export interface GmvByPlatform {
  tiktok: number | null;
  shopee: null;
  lazada: null;
}

export interface CompanySnapshot {
  // GMV over the SELECTED range (Manila) — Σ of brands[].gmv from
  // tiktok_shop_performance (equals sum(brands) exactly, same source). Null when
  // no brand reported in the range (honest "—", never a fabricated 0).
  gmv: number | null;
  // Orders over the SELECTED range (Manila).
  orders: number | null;
  // GMV by sales platform for the SELECTED range — tiktok real, shopee/lazada null.
  gmv_by_platform: GmvByPlatform;
  // Brands with real commerce activity in the SELECTED range (the Commerce lens).
  active_brands: number | null;
  // Client relationships whose engagement status is 'active' (the Business Dev
  // lens). In this OS the brand record IS the client record, so this counts active
  // brand/client engagements — a different question than active_brands.
  active_clients: number | null;
  // ISO-8601 instant the snapshot was computed (server now).
  generated_at: string;
}

export interface BrandSnapshot {
  brand_id: string;
  name: string;
  // Live TikTok Shop GMV / orders for the brand over the SELECTED range (Manila).
  gmv: number | null;
  orders: number | null;
  // The FML/Alianna brand_id mapping is fixed upstream, so brand rows are always
  // attributed — never an unmapped shop. Kept explicit for the UI contract.
  unmapped: false;
}

export type DepartmentStatus = "green" | "amber" | "red" | null;

export interface DepartmentSnapshot {
  key: string;
  label: string;
  // The department's headline health figure (0..100 efficiency from its latest
  // snapshot), or null when no snapshot has been recorded yet.
  headline_metric: number | null;
  // RAG derived from the headline: >=75 green, >=50 amber, else red; null when
  // there is no headline to grade.
  status: DepartmentStatus;
}

export interface ClientSnapshot {
  client_id: string;
  brand_id: string;
  name: string;
  // GMV over the SELECTED range for the client — the SAME per-brand
  // tiktok_shop_performance figure as brands[], so clients reconcile with
  // company.gmv by construction.
  gmv: number | null;
  // Latest metric-entry validation status for the client this month (e.g.
  // 'pending' / 'validated' / 'variance'), or null when nothing was reported.
  report_status: string | null;
}

// A single sales-platform slice of the range's GMV (drives the donut).
export interface PlatformSlice {
  platform: string; // canonical platform key, e.g. "tiktok_shop"
  label: string; // display label, e.g. "TikTok Shop"
  gmv: number;
  pct: number; // 0..100 share of sales GMV
}

export interface PlatformSplitSnapshot {
  slices: PlatformSlice[];
  total_gmv: number;
  has_data: boolean;
  currency: string;
  window_label: string; // the selected range's label
}

export interface PulsePoint {
  iso_week: string; // "2026-W28"
  label: string; // "Jul 6 – Jul 12"
  gmv: number; // weekly TikTok GMV (0 for a genuinely empty week)
}

export interface RevenuePulseSnapshot {
  points: PulsePoint[]; // 12 ISO weeks ending at the range's end, chronological
  has_data: boolean; // any week carried real GMV
  currency: string;
}

export interface FinanceSnapshot {
  // Projected NET change in cash over the next 30 days, and the projected end
  // balance — mirrors the Command Center Cash Flow tile. Null when no cash
  // position anchor has been set.
  cash_flow_30d: number | null;
  cash_end_balance: number | null;
  cash_as_of: string | null;
  currency: string;
}

export interface OsSnapshot {
  // The window everything commerce-related below is scoped to.
  range: SnapshotRange;
  // How fresh the underlying TikTok data is.
  freshness: Freshness;
  company: CompanySnapshot;
  brands: BrandSnapshot[];
  departments: DepartmentSnapshot[];
  clients: ClientSnapshot[];
  // GMV-by-Platform donut for the selected range.
  platform_split: PlatformSplitSnapshot;
  // 12-week Revenue Pulse ending at the selected range's end.
  revenue_pulse: RevenuePulseSnapshot;
  // Populated ONLY for ceo/coo; null (block omitted) for every other role.
  finance: FinanceSnapshot | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Sum a brand's live daily series over an inclusive [start,end] window (YYYY-MM-DD
// lexicographic compare — stat_date is already a Manila calendar day). Returns the
// RAW (unrounded) sums, or nulls when the brand reported nothing in the window
// (honest "—", never a 0). Rounding is deferred to the point of display: the
// company total rounds the raw Σ once (so it matches the DB total to the peso),
// while each brand row rounds its own raw figure — rounding per brand first would
// let sub-peso remainders accumulate and drift the company total by a few pesos.
function sumLiveDays(
  days: BrandDay[] | undefined,
  win: ResolvedWindow
): { gmv: number | null; orders: number | null } {
  if (!days || days.length === 0) return { gmv: null, orders: null };
  let gmv = 0;
  let orders = 0;
  let matched = 0;
  for (const d of days) {
    if (d.statDate >= win.start && d.statDate <= win.end) {
      gmv += d.gmv;
      orders += d.orders;
      matched += 1;
    }
  }
  if (matched === 0) return { gmv: null, orders: null };
  return { gmv, orders };
}

// Sum a set of per-brand RAW figures, treating a brand's null as "did not report"
// (contributes nothing). Returns null only when EVERY brand is null — so the
// company total is an honest "—" iff no brand reported, never a fabricated 0. The
// accumulated sum is rounded ONCE here, so the company figure equals the DB total
// to the peso rather than the sum of independently-rounded brand figures.
function sumNullable(vals: (number | null)[]): number | null {
  let acc = 0;
  let any = false;
  for (const v of vals) {
    if (v != null) {
      acc += v;
      any = true;
    }
  }
  return any ? round(acc) : null;
}

function ragStatus(v: number | null): DepartmentStatus {
  if (v == null) return null;
  if (v >= 75) return "green";
  if (v >= 50) return "amber";
  return "red";
}

function deptKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || name;
}

// A slow / missing source degrades to a neutral shape rather than sinking the
// whole snapshot — mirrors lib/ceo/mission-control.ts.
function safe<T>(p: PromiseLike<T>, fallback: T): Promise<T> {
  return Promise.resolve(p).then((v) => v, () => fallback);
}

// The UTC instant of noon on a YYYY-MM-DD Manila day — a safe interior point for
// anchoring the ISO-week walk to the range's end (noon avoids any day-boundary
// rounding). Falls back to `now` if the date can't be parsed.
function manilaNoonMs(ymd: string, nowMs: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return nowMs;
  // 12:00 Manila (UTC+8) == 04:00Z the same calendar day.
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 4, 0, 0, 0);
  return Number.isFinite(ms) ? ms : nowMs;
}

// ── The assembler ─────────────────────────────────────────────────────────────

export interface BuildSnapshotArgs {
  supabase: Client;
  orgId: string;
  role: UserRole | string;
  // The selected range everything commerce-related is scoped to. Defaults to
  // month-to-date (the Command Center default) when the caller passes none, so an
  // un-parameterised request keeps the historical behaviour.
  range?: { key?: string; start: string; end: string; label: string };
  nowMs?: number;
}

export async function buildSnapshot(args: BuildSnapshotArgs): Promise<OsSnapshot> {
  const { supabase, orgId, role } = args;
  const nowMs = args.nowMs ?? Date.now();
  // The selected window. customWindow keeps the range's own label; default = MTD.
  const win: ResolvedWindow = args.range
    ? customWindow(args.range.start, args.range.end, args.range.label)
    : monthToDate(nowMs);
  const rangeKey = args.range?.key ?? "mtd";
  const leadership = isLeadershipRole(role);
  // Read simple org-scoped tables through the untyped shim — same as the Command
  // Center assembler — to sidestep the @supabase/ssr select-inference `never`
  // quirk. RLS still applies (it's the same request-scoped client). Never writes.
  const u = supabase as unknown as Shim;

  const [brandRows, liveByBrand, deptRows, snapshotRows, entryRows, cashflow] =
    await Promise.all([
      // Fallbacks use `any[]` to dodge the @supabase/ssr select-inference `never`
      // quirk; each result is cast to its real row shape on read below.
      safe(u.from("brands").select("id, name, status").order("name"), {
        data: [] as any[],
      }),
      safe(getLiveDaysByBrand(supabase), new Map<string, BrandDay[]>()),
      safe(u.from("departments").select("id, name").order("name"), {
        data: [] as any[],
      }),
      safe(
        u
          .from("metrics_snapshots")
          .select("department_id, efficiency, period_end")
          .not("department_id", "is", null)
          .order("period_end", { ascending: false }),
        { data: [] as any[] }
      ),
      // Latest metric-entry validation status per brand this month (report status).
      safe(
        u
          .from("metric_entries")
          .select("brand_id, validation_status, period_end")
          .gte("period_end", monthToDate(nowMs).start)
          .lte("period_end", monthToDate(nowMs).end)
          .order("period_end", { ascending: false }),
        { data: [] as any[] }
      ),
      // Finance is a leadership-only read; never even fetched for other roles.
      // Called identically to the Command Center assembler (no actorRole) so the
      // figure reconciles with the Cash Flow tile exactly; the leadership gate
      // above + finance-table RLS are what actually restrict this read.
      leadership
        ? safe(
            loadCashflow(u, orgId, { horizonDays: 30 }),
            null as Awaited<ReturnType<typeof loadCashflow>> | null
          )
        : Promise.resolve(null),
    ]);

  const brands = ((brandRows.data ?? []) as unknown as {
    id: string;
    name: string;
    status: string;
  }[]) ?? [];

  // ── per-brand TikTok set (the ONE GMV source), scoped to the SELECTED range ──
  // Sum tiktok_shop_performance per brand over the range, joined to the brands
  // table for the name. company, clients[] and the pulse all derive from THIS set,
  // so company == Σ brands holds by construction — no second GMV source to drift.
  const perBrand = brands.map((b) => {
    const days = liveByBrand.get(b.id);
    return { id: b.id, name: b.name, ...sumLiveDays(days, win) };
  });

  // ── brands[] ── (each brand rounds its OWN raw figure for display)
  const brandSnaps: BrandSnapshot[] = perBrand.map((p) => ({
    brand_id: p.id,
    name: p.name,
    gmv: p.gmv == null ? null : round(p.gmv),
    orders: p.orders == null ? null : round(p.orders),
    unmapped: false as const,
  }));
  // Brands sort by the range's GMV desc; unreported (null) sink last.
  brandSnaps.sort((a, b) => (b.gmv ?? -1) - (a.gmv ?? -1) || a.name.localeCompare(b.name));

  // ── company (Σ over the SAME per-brand set) ──
  const gmv = sumNullable(perBrand.map((p) => p.gmv));
  const ordersTotal = sumNullable(perBrand.map((p) => p.orders));
  // Active brands = distinct brand_id with >0 GMV in the SELECTED range.
  const activeBrandCount = perBrand.filter((p) => p.gmv != null && p.gmv > 0).length;
  const activeClientCount = brands.filter(
    (b) => (b.status ?? "").toLowerCase() === "active"
  ).length;

  const company: CompanySnapshot = {
    gmv,
    orders: ordersTotal,
    // TikTok-only today; shopee/lazada are honest nulls (no clean live pipe yet).
    gmv_by_platform: { tiktok: gmv, shopee: null, lazada: null },
    active_brands: brands.length > 0 ? activeBrandCount : null,
    active_clients: brands.length > 0 ? activeClientCount : null,
    generated_at: new Date(nowMs).toISOString(),
  };

  // ── platform_split (donut) — tiktok is the only live sales pipe today ──
  const platform_split: PlatformSplitSnapshot = {
    slices:
      gmv != null && gmv > 0
        ? [{ platform: "tiktok_shop", label: "TikTok Shop", gmv, pct: 100 }]
        : [],
    total_gmv: gmv != null && gmv > 0 ? gmv : 0,
    has_data: gmv != null && gmv > 0,
    currency: "PHP",
    window_label: win.label,
  };

  // ── freshness (max stat_date across the org's live rows vs Manila today) ──
  let maxStatDate: string | null = null;
  for (const series of liveByBrand.values()) {
    for (const d of series) {
      if (maxStatDate === null || d.statDate > maxStatDate) maxStatDate = d.statDate;
    }
  }
  const today = todayManila(nowMs);
  const freshness: Freshness = {
    max_stat_date: maxStatDate,
    today,
    is_stale: maxStatDate != null && maxStatDate < today,
    as_of_label: shortDay(maxStatDate),
  };

  // ── revenue_pulse (12 ISO weeks ending at the range's end) ──
  const pulseAnchorMs = manilaNoonMs(win.end, nowMs);
  const pulsePoints: PulsePoint[] = [];
  let pulseHasData = false;
  for (let off = -11; off <= 0; off++) {
    const w = isoWeekManila(pulseAnchorMs, off);
    let weekGmv = 0;
    for (const series of liveByBrand.values()) {
      for (const d of series) {
        if (d.statDate >= w.start && d.statDate <= w.end) weekGmv += d.gmv;
      }
    }
    if (weekGmv > 0) pulseHasData = true;
    pulsePoints.push({ iso_week: w.isoWeek, label: w.label, gmv: round(weekGmv) });
  }
  const revenue_pulse: RevenuePulseSnapshot = {
    points: pulsePoints,
    has_data: pulseHasData,
    currency: "PHP",
  };

  // ── departments[] ──
  const latestByDept = new Map<string, number>();
  for (const s of (snapshotRows.data ?? []) as {
    department_id: string | null;
    efficiency: number;
  }[]) {
    if (!s.department_id) continue;
    if (!latestByDept.has(s.department_id)) latestByDept.set(s.department_id, Number(s.efficiency));
  }
  const departments: DepartmentSnapshot[] = (
    (deptRows.data ?? []) as { id: string; name: string }[]
  ).map((d) => {
    const eff = latestByDept.has(d.id) ? latestByDept.get(d.id)! : null;
    const headline = eff == null || !Number.isFinite(eff) ? null : round(eff);
    return {
      key: deptKey(d.name),
      label: d.name,
      headline_metric: headline,
      status: ragStatus(headline),
    };
  });

  // ── clients[] (canonical brand record) ──
  const reportByBrand = new Map<string, string>();
  for (const e of (entryRows.data ?? []) as {
    brand_id: string | null;
    validation_status: string;
  }[]) {
    if (e.brand_id && !reportByBrand.has(e.brand_id)) {
      reportByBrand.set(e.brand_id, e.validation_status);
    }
  }
  const clients: ClientSnapshot[] = perBrand.map((p) => ({
    client_id: p.id,
    brand_id: p.id,
    name: p.name,
    // Same range GMV figure as brands[] — clients reconcile with company too.
    gmv: p.gmv == null ? null : round(p.gmv),
    report_status: reportByBrand.get(p.id) ?? null,
  }));
  clients.sort((a, b) => (b.gmv ?? -1) - (a.gmv ?? -1) || a.name.localeCompare(b.name));

  // ── finance (ceo/coo ONLY) ──
  let finance: FinanceSnapshot | null = null;
  if (leadership && cashflow) {
    const f = cashflow.forecast;
    finance = {
      cash_flow_30d: f != null ? round(f.endBalance - f.startBalance) : null,
      cash_end_balance: f != null ? round(f.endBalance) : null,
      cash_as_of: cashflow.anchor?.as_of_date ?? null,
      currency: "PHP",
    };
  }

  return {
    range: { key: rangeKey, start: win.start, end: win.end, label: win.label },
    freshness,
    company,
    brands: brandSnaps,
    departments,
    clients,
    platform_split,
    revenue_pulse,
    finance,
  };
}
