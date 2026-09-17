// lib/briefings/exec-figures.ts
// PR 7 — the Executive Briefing's FIGURES, resolved LIVE at render time.
//
// The org briefing NARRATIVE is cached AI prose (org_briefings.summary) and can
// legitimately be hours or days old. Its NUMBERS may not: a card that says
// "MTD GMV ₱5.7M · 11 brands · zero snapshots" while the OS actually holds
// ₱12.3M / 12 brands / 8 snapshots is serving false data as if current. This
// helper recomputes those headline figures from the SAME canonical sources the
// briefing engine (lib/briefings/generate.ts) reads — GMV from
// tiktok_shop_performance via the one commerce reader, counts from brands /
// metrics_snapshots — so the strip on the card always reflects the live truth and
// reconciles, by construction, with a freshly regenerated narrative.
//
// Month-to-date, fixed — this is the briefing's own scope (period_start = the 1st
// of the current Manila month), independent of the dashboard's date-range control.
import { fetchCommerceRows } from "@/lib/metrics/gmv";
import { getBrandLiveDays, sumBrandWindow } from "@/lib/metrics/tiktok-live";
import { todayManila } from "@/lib/metrics/windows";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type Supabase = ReturnType<typeof createServerSupabaseClient>;

export interface ExecBriefingFigures {
  gmvMtd: number | null; // null = no commerce rows at all (render "—", never 0)
  gmvPriorMonth: number | null;
  currency: string;
  curMonth: string; // 'YYYY-MM'
  priorMonth: string; // 'YYYY-MM'
  activeBrands: number;
  archivedBrands: number;
  deptSnapshots: number; // department-level metrics_snapshots on file
  latestSnapshotPeriod: string | null; // max period_end among them
}

// Staleness of a cached briefing. The narrative is allowed to be old, but the
// UI must say so loudly once it crosses a day — the defect PR 7 fixes was a 10-
// day-old briefing rendered as if current, with no signal at all.
export interface BriefingStaleness {
  ageHours: number;
  ageDays: number;
  isStale: boolean; // strictly older than the staleness threshold
}

// `staleAfterHours` defaults to 24 — the cached-briefing threshold this was born
// for. Callers with a different freshness contract pass their own (e.g. a cash
// position is expected to hold for a week, so Finance passes 7 * 24). Everything
// else about the computation, and the banner that renders it, is identical.
export function briefingStaleness(
  createdAtIso: string | null | undefined,
  nowMs: number,
  staleAfterHours = 24
): BriefingStaleness | null {
  if (!createdAtIso) return null;
  const t = new Date(createdAtIso).getTime();
  if (!Number.isFinite(t)) return null;
  const ageMs = Math.max(0, nowMs - t);
  const ageHours = ageMs / 3_600_000;
  return { ageHours, ageDays: Math.floor(ageHours / 24), isStale: ageHours > staleAfterHours };
}

const num = (v: number | null | undefined): number => (v == null ? 0 : Number(v));
const monthKey = (s: string | null | undefined): string | null =>
  s && s.length >= 7 ? s.slice(0, 7) : null;

// Live canonical figures for the Executive Briefing card. Mirrors exactly the
// aggregation generateOrgBriefing() performs (plain per-(brand,day) sum of the
// live commerce rows attributed by period_end month), so the rendered figures and
// a regenerated narrative can never disagree.
export async function getExecBriefingFigures(supabase: Supabase): Promise<ExecBriefingFigures> {
  const today = todayManila();
  const curMonth = today.slice(0, 7);
  const prior = new Date(`${curMonth}-01T00:00:00Z`);
  prior.setUTCMonth(prior.getUTCMonth() - 1);
  const priorMonth = prior.toISOString().slice(0, 7);

  const u = supabase as unknown as { from: (t: string) => any };
  const [rows, brandsRes, snapsRes] = await Promise.all([
    fetchCommerceRows(supabase),
    u.from("brands").select("status, archived_at"),
    u
      .from("metrics_snapshots")
      .select("period_end, department_id")
      .not("department_id", "is", null),
  ]);

  const hasCommerce = rows.length > 0;
  const sumMonth = (mk: string) =>
    rows.filter((r) => monthKey(r.period_end) === mk).reduce((a, r) => a + num(r.gmv), 0);
  const gmvMtd = hasCommerce ? sumMonth(curMonth) : null;
  const gmvPriorMonth = hasCommerce ? sumMonth(priorMonth) : null;
  const currency = (rows.find((r) => r.currency)?.currency ?? "PHP") || "PHP";

  const brandRows = (brandsRes.data ?? []) as { status: string; archived_at: string | null }[];
  // "Active" = brands not archived (mirrors the portfolio's archived filter); a
  // brand is archived when it carries an archived_at, regardless of status text.
  const archivedBrands = brandRows.filter((b) => b.archived_at != null).length;
  const activeBrands = brandRows.length - archivedBrands;

  const snapRows = (snapsRes.data ?? []) as { period_end: string | null }[];
  const deptSnapshots = snapRows.length;
  const latestSnapshotPeriod = snapRows.reduce<string | null>(
    (max, r) => (r.period_end && (!max || r.period_end > max) ? r.period_end : max),
    null
  );

  return {
    gmvMtd,
    gmvPriorMonth,
    currency,
    curMonth,
    priorMonth,
    activeBrands,
    archivedBrands,
    deptSnapshots,
    latestSnapshotPeriod,
  };
}

// ── ACCOUNT (brand) — PR 8 ─────────────────────────────────────────────────────
// The account briefing (account_briefings.summary) is CLIENT-FACING AI prose with
// per-brand GMV / metric figures baked in at generation. Those numbers must not be
// served as current: this resolves the brand's headline commerce figures LIVE from
// the SAME canonical source the Accounts page already reads for its truthfulness
// badge — the live per-brand tiktok_shop_performance series (lib/metrics/tiktok-
// live) — so the figures beside the cached prose always reflect the live truth.
//
// CLIENT-FACING honesty (never a stale number, never a fabricated 0): every figure
// is null unless a live daily row actually falls in its window. sumBrandWindow
// returns null when no day matched — the strip renders "—" then, never 0.
export interface AccountBriefingFigures {
  gmvMtd: number | null;
  ordersMtd: number | null;
  unitsMtd: number | null;
  gmvPriorMonth: number | null;
  latestDay: { statDate: string; gmv: number; orders: number; units: number } | null;
  currency: string;
  curMonth: string; // 'YYYY-MM'
  priorMonth: string; // 'YYYY-MM'
  liveRows: number; // live daily commerce rows on file for this brand
}

// Last-of-month day string for lexicographic window compares. stat_date is a plain
// YYYY-MM-DD, so "YYYY-MM-31" is an inclusive upper bound for any real day in that
// month (no real day sorts above it) and excludes the next month's first day.
const monthEnd = (ym: string) => `${ym}-31`;

export async function getAccountBriefingFigures(
  supabase: Supabase,
  brandId: string
): Promise<AccountBriefingFigures> {
  const today = todayManila();
  const curMonth = today.slice(0, 7);
  const prior = new Date(`${curMonth}-01T00:00:00Z`);
  prior.setUTCMonth(prior.getUTCMonth() - 1);
  const priorMonth = prior.toISOString().slice(0, 7);

  // One read of the live per-brand series (RLS org-scopes it under the request
  // client). Ascending by day, so the last element is the latest live day.
  const days = await getBrandLiveDays(supabase, brandId);

  const mtd = sumBrandWindow(days, `${curMonth}-01`, today);
  const priorAgg = sumBrandWindow(days, `${priorMonth}-01`, monthEnd(priorMonth));
  const last = days[days.length - 1] ?? null;
  const currency = days.find((d) => d.currency)?.currency ?? "PHP";

  return {
    gmvMtd: mtd.gmv,
    ordersMtd: mtd.orders,
    unitsMtd: mtd.units,
    gmvPriorMonth: priorAgg.gmv,
    latestDay: last
      ? { statDate: last.statDate, gmv: last.gmv, orders: last.orders, units: last.units }
      : null,
    currency,
    curMonth,
    priorMonth,
    liveRows: days.length,
  };
}

// ── DEPARTMENT — PR 8 ──────────────────────────────────────────────────────────
// The department action plan (department_briefings.action_plan) bakes in the
// snapshot's efficiency / quality / capacity / GMV-impact at generation. These
// resolve LIVE from the department's latest metrics_snapshots row (the SAME
// canonical source the Departments/Metrics "Results" bars read, written by the
// automated rollup) so the figures beside the cached plan are always current.
//
// A null figure renders "—" (honest), never a fabricated 0. Percent figures are
// 0..100; gmvImpact is a peso amount.
export interface DepartmentBriefingFigures {
  efficiency: number | null;
  quality: number | null;
  capacity: number | null;
  gmvImpact: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

// The raw latest-snapshot columns → the figures shape. Pure, so a caller that has
// already fetched the snapshot (the Departments page) and the async resolver below
// (the Metrics page) build the identical object with no second code path.
export function deptFiguresFromSnapshot(
  row: {
    efficiency: number | null;
    quality_score: number | null;
    capacity_utilization: number | null;
    gmv_impact: number | null;
    period_start: string | null;
    period_end: string | null;
  } | null
): DepartmentBriefingFigures | null {
  if (!row) return null;
  const n = (v: number | null | undefined): number | null =>
    v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    efficiency: n(row.efficiency),
    quality: n(row.quality_score),
    capacity: n(row.capacity_utilization),
    gmvImpact: n(row.gmv_impact),
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

// Resolve the department's latest snapshot figures LIVE (most recent by period_end).
export async function getDepartmentBriefingFigures(
  supabase: Supabase,
  departmentId: string
): Promise<DepartmentBriefingFigures | null> {
  const u = supabase as unknown as { from: (t: string) => any };
  const res = await u
    .from("metrics_snapshots")
    .select("efficiency, quality_score, capacity_utilization, gmv_impact, period_start, period_end")
    .eq("department_id", departmentId)
    .order("period_end", { ascending: false })
    .limit(1);
  return deptFiguresFromSnapshot((res.data ?? [])[0] ?? null);
}
