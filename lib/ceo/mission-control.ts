// lib/ceo/mission-control.ts — the ONE assembler for the CEO Mission Control
// panels-with-charts layout.
//
// Every figure on the Mission Control page is read LIVE from the OS's own tables
// through the caller's RLS-scoped server client and the shared metrics layer, so
// the charts reconcile to the peso with the rest of the OS (Command Center,
// Reports, Finance, Scoreboard). Nothing here fabricates a number: a metric with
// no underlying signal returns null and the UI renders an honest "—" / empty
// state, never a zero dressed up as data. No schema change — this only READS.
//
// Sources, one per panel:
//   • KPI · Business Health   → lib/metrics/signals (efficiency + quality mean)
//   • KPI · Revenue MTD       → tiktok_shop_performance via lib/metrics/tiktok-live
//   • KPI · Cash Flow 30d     → lib/finance/data (cash_positions + finance signals)
//   • KPI · AI Cognition      → distinct active loops in action_requests (30d)
//   • Revenue Pulse           → weekly TikTok GMV over the last 12 ISO weeks (live)
//   • GMV by Platform         → live TikTok GMV (Shopee/Lazada honest null, donut)
//   • Department Health       → metrics_snapshots per department (composite)
//   • Workflow Activity       → action_audit events bucketed by Manila day
//   • Growth Flywheel         → pods + pod_brands via lib/vesper/scoreboard
//   • Executive Feed          → pending action_requests (proactive-loop output)

import type { createServerSupabaseClient } from "@/lib/supabase/server";
// GMV COMES FROM ONE SOURCE now: tiktok_shop_performance via lib/metrics/tiktok-live
// (the same live per-brand reader lib/os/snapshot.ts uses), so company == Σ brands
// and every OS surface reconciles to the peso. brand_platform_metrics is RETIRED
// for reads here — it disagreed with the live TikTok figures on every brand in both
// directions (over- and under-counting, plus phantom revenue) and its writer trails
// the live table by days; PR 3 stops sourcing any figure from it. `platformLabel`
// is a pure label map (no bpm read) and stays.
import { platformLabel, type Platform } from "@/lib/metrics/gmv";
import {
  getLiveDaysByBrand,
  orgWindow,
  sumOrgGmvWindow,
  type BrandDay,
} from "@/lib/metrics/tiktok-live";
import { computeOrgSignals, computeDepartmentEfficiency } from "@/lib/metrics/signals";
import type { SignalValue } from "@/lib/metrics/signals";
import { computeScoreboard } from "@/lib/vesper/scoreboard";
import { loadCashflow } from "@/lib/finance/data";
import {
  customWindow,
  isoWeekManila,
  manilaStamp,
  resolveWindow,
  type WindowKey,
  type ResolvedWindow,
} from "@/lib/metrics/windows";
import type { ActionRequestRow } from "@/lib/actions/types";

export type { WindowKey } from "@/lib/metrics/windows";

export type { Platform } from "@/lib/metrics/gmv";

type Client = ReturnType<typeof createServerSupabaseClient>;
// Escape hatch for tables not in the generated types (action_requests,
// action_audit, metrics_snapshots read-through) — the same read-only cast shim
// the Live / Contracts / Approvals modules use. Never writes.
type UntypedClient = { from: (t: string) => any };

const round = (n: number, d = 0) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

// ── Panel value shapes ────────────────────────────────────────────────────────

export interface Kpis {
  currency: string;
  // Business Health: 0..100 composite of the higher-is-better org signals, or
  // null when neither efficiency nor quality can be measured yet.
  health: number | null;
  healthBasis: string | null;
  // Revenue: GMV over the SELECTED window (defaults to month-to-date). Its delta
  // vs the comparable prior window (%), the human label of that comparison, the
  // active window's label, and a 12-week trend for the sparkline.
  revenueMtd: number | null;
  revenueDeltaPct: number | null;
  revenueDeltaLabel: string | null; // e.g. "vs last month", "vs prior 7d"
  windowLabel: string; // the active window's label, e.g. "MTD", "Last 7 days"
  revenueSpark: number[]; // weekly GMV, chronological (may be empty)
  // Cash Flow 30d: projected NET change in cash over the next 30 days, plus the
  // projected end balance for context. Null when no cash position is set.
  cashFlow30d: number | null;
  cashEndBalance: number | null;
  cashAsOf: string | null;
  // AI Cognition: distinct proactive AI loops active in the last 30 days.
  activeLoops: number | null;
  loopNames: string[];
}

export interface RevenuePulsePoint {
  isoWeek: string;
  label: string;
  gmv: number;
}
export interface RevenuePulse {
  points: RevenuePulsePoint[];
  hasData: boolean;
  currency: string;
}

export interface PlatformSlice {
  platform: Platform;
  label: string;
  gmv: number;
  pct: number; // 0..100 share of sales GMV
}
export interface PlatformSplit {
  slices: PlatformSlice[];
  totalGmv: number;
  hasData: boolean;
  currency: string;
  windowLabel: string;
  // Sales platforms with NO clean live pipe today (Shopee, Lazada). Rendered as an
  // honest "not connected" in the legend rather than a stale brand_platform_metrics
  // number or a fabricated 0 — the only honest thing to show until a live pipe lands.
  disconnected: { platform: Platform; label: string }[];
}

export interface DeptHealthRow {
  id: string;
  name: string;
  score: number | null; // 0..100 composite, or null when no snapshot
}
export interface DeptHealth {
  rows: DeptHealthRow[];
  hasAny: boolean;
  periodLabel: string | null;
}

export interface WorkflowDay {
  date: string; // YYYY-MM-DD (Manila)
  label: string; // "Jul 8"
  drafted: number;
  executed: number;
}
export interface WorkflowActivity {
  days: WorkflowDay[];
  hasData: boolean;
  totalDrafted: number;
  totalExecuted: number;
}

export interface Flywheel {
  pods: number;
  brandsUnderManagement: number;
  actualPerPod: number | null; // brands ÷ pods, null when no pods
  targetPerPod: number | null; // mean of pods' target_brands, null when unset
  hasData: boolean;
}

// One executive-feed item, derived from a pending action_request. `kind` splits
// the queue the way the design peg's feed does.
export type FeedKind = "APPROVAL" | "BOTTLENECK" | "RECOMMEND";
export interface FeedItem {
  request: ActionRequestRow;
  kind: FeedKind;
}
export interface ExecutiveFeed {
  items: FeedItem[];
  pendingTotal: number;
}

export interface MissionControl {
  kpis: Kpis;
  revenuePulse: RevenuePulse;
  platformSplit: PlatformSplit;
  deptHealth: DeptHealth;
  workflow: WorkflowActivity;
  flywheel: Flywheel;
  feed: ExecutiveFeed;
  asOf: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

// YYYY-MM-DD in Asia/Manila for a UTC instant (fixed +8, no DST — exact).
function manilaYmd(utcMs: number): string {
  const d = new Date(utcMs + MANILA_OFFSET_MS);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function shortLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  return `${SHORT_MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

// The previous calendar month's month-to-date window (days 1..sameDay), for the
// Revenue MTD pace delta. Pure YYYY-MM-DD arithmetic in Manila.
function priorMonthToDate(nowMs: number): { start: string; end: string } {
  const today = manilaYmd(nowMs);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)); // 1..12
  const day = Number(today.slice(8, 10));
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  // Clamp the same day-of-month to the prior month's length.
  const daysInPrior = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const endDay = Math.min(day, daysInPrior);
  const p = (x: number) => String(x).padStart(2, "0");
  return { start: `${py}-${p(pm)}-01`, end: `${py}-${p(pm)}-${p(endDay)}` };
}

// Count of inclusive calendar days spanned by a YYYY-MM-DD window.
function windowDaySpan(win: ResolvedWindow): number {
  const s = Date.parse(`${win.start}T00:00:00Z`);
  const e = Date.parse(`${win.end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.round((e - s) / DAY_MS) + 1;
}

// The equal-length window immediately preceding `win`, for the trailing-window
// revenue deltas (last7 / last30). Pure YYYY-MM-DD arithmetic in Manila.
function precedingWindow(win: ResolvedWindow): { start: string; end: string } {
  const span = windowDaySpan(win);
  const startMs = Date.parse(`${win.start}T00:00:00Z`);
  const priorEnd = startMs - DAY_MS;
  const priorStart = priorEnd - (span - 1) * DAY_MS;
  return { start: manilaYmd(priorStart), end: manilaYmd(priorEnd) };
}

// ── Sub-assemblers ────────────────────────────────────────────────────────────

function buildRevenuePulse(
  liveByBrand: Map<string, BrandDay[]>,
  nowMs: number,
  weeks = 12
): RevenuePulse {
  // Weekly TikTok GMV over the trailing `weeks` ISO weeks ending this week, summed
  // across every brand from the SAME live set as the Revenue tile — so the pulse
  // reconciles with the headline figure by construction. A genuinely empty week is
  // a real, measured 0 (not a "—"): only the whole pulse is "no data" when no week
  // carried GMV.
  const points: RevenuePulsePoint[] = [];
  let any = false;
  for (let off = -(weeks - 1); off <= 0; off++) {
    const w = isoWeekManila(nowMs, off);
    const gmv = sumOrgGmvWindow(liveByBrand, w.start, w.end);
    if (gmv > 0) any = true;
    points.push({ isoWeek: w.isoWeek, label: w.label, gmv: round(gmv) });
  }
  return { points, hasData: any, currency: "PHP" };
}

// TikTok is the only sales channel with a clean live pipe today, so the donut has
// one real slice (TikTok Shop) and lists Shopee/Lazada as honest "not connected"
// — never the stale brand_platform_metrics figure (which double-counted Shopee) nor
// a fabricated 0. When TikTok GMV is 0 for the window the whole split is "no data".
function buildPlatformSplit(liveByBrand: Map<string, BrandDay[]>, win: ResolvedWindow): PlatformSplit {
  const gmv = orgWindow(liveByBrand, win.start, win.end).gmv ?? 0;
  const total = round(gmv);
  const slices: PlatformSlice[] =
    total > 0
      ? [{ platform: "tiktok_shop" as Platform, label: platformLabel("tiktok_shop"), gmv: total, pct: 100 }]
      : [];
  return {
    slices,
    totalGmv: total,
    hasData: total > 0,
    currency: "PHP",
    windowLabel: win.label,
    disconnected: [
      { platform: "shopee" as Platform, label: platformLabel("shopee") },
      { platform: "lazada" as Platform, label: platformLabel("lazada") },
    ],
  };
}

interface SnapshotRow {
  department_id: string | null;
  efficiency: number | null;
  quality_score: number | null;
  period_end: string;
}

function buildDeptHealth(
  departments: { id: string; name: string }[],
  snapshots: SnapshotRow[],
  deptEfficiency: Map<string, SignalValue>
): DeptHealth {
  // Latest snapshot per department (rows arrive newest-first). The snapshot now
  // supplies ONLY the Quality half of health — Efficiency comes from the live
  // confirmed-daily-report signal (deptEfficiency), the single source of truth.
  const latest = new Map<string, SnapshotRow>();
  let periodLabel: string | null = null;
  for (const s of snapshots) {
    if (!s.department_id) continue;
    if (!latest.has(s.department_id)) {
      latest.set(s.department_id, s);
      if (!periodLabel) periodLabel = s.period_end;
    }
  }
  const rows: DeptHealthRow[] = departments.map((d) => {
    const s = latest.get(d.id);
    const parts: number[] = [];
    // Efficiency: confirmed-via-daily-report signal (honest null when none).
    const eff = deptEfficiency.get(d.id);
    if (eff && eff.value != null) parts.push(eff.value);
    // Quality: still the recorded snapshot figure.
    if (s && s.quality_score != null) parts.push(Number(s.quality_score));
    const score = parts.length ? round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
    return { id: d.id, name: d.name, score };
  });
  return {
    rows,
    hasAny: rows.some((r) => r.score != null),
    periodLabel,
  };
}

interface AuditRow {
  event: string;
  created_at: string;
}

function buildWorkflowActivity(audit: AuditRow[], nowMs: number, days = 14): WorkflowActivity {
  // Bucket audit events by Manila day over the trailing window. "drafted" = a
  // proactive loop produced an action; "executed" = the OS ran an approved one.
  const buckets = new Map<string, { drafted: number; executed: number }>();
  const order: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const ymd = manilaYmd(nowMs - i * DAY_MS);
    buckets.set(ymd, { drafted: 0, executed: 0 });
    order.push(ymd);
  }
  let totalDrafted = 0;
  let totalExecuted = 0;
  for (const a of audit) {
    const ymd = manilaYmd(new Date(a.created_at).getTime());
    const b = buckets.get(ymd);
    if (!b) continue;
    if (a.event === "created") {
      b.drafted += 1;
      totalDrafted += 1;
    } else if (a.event === "executed") {
      b.executed += 1;
      totalExecuted += 1;
    }
  }
  const daysOut: WorkflowDay[] = order.map((ymd) => {
    const b = buckets.get(ymd)!;
    return { date: ymd, label: shortLabel(ymd), drafted: b.drafted, executed: b.executed };
  });
  return {
    days: daysOut,
    hasData: totalDrafted + totalExecuted > 0,
    totalDrafted,
    totalExecuted,
  };
}

// Categorise a pending action_request for the executive feed:
//   • BOTTLENECK — a high-risk (L3+) flag that's holding something up.
//   • APPROVAL   — carries an executable action awaiting a tap.
//   • RECOMMEND  — recommendation-only (Tony's advice; nothing to execute).
function feedKind(r: ActionRequestRow): FeedKind {
  if (r.risk_tier >= 3) return "BOTTLENECK";
  if (r.proposed_action?.type) return "APPROVAL";
  return "RECOMMEND";
}

// ── The assembler ─────────────────────────────────────────────────────────────

export async function loadMissionControl(
  supabase: Client,
  orgId: string,
  opts: {
    nowMs?: number;
    windowKey?: WindowKey;
    // When provided, an explicit [start,end] window (from the shared date-range
    // control) overrides `windowKey` for the windowed reads — Revenue and the
    // GMV-by-Platform split. `compareRange` (+ `compareLabel`) drive the revenue
    // delta when the user picked a Compare mode; without it the delta falls back
    // to the equal-length preceding span.
    range?: { start: string; end: string; label: string };
    compareRange?: { start: string; end: string } | null;
    compareLabel?: string | null;
  } = {}
): Promise<MissionControl> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowKey: WindowKey = opts.windowKey ?? "mtd";
  // A custom range takes precedence over the preset window when supplied.
  const win = opts.range
    ? customWindow(opts.range.start, opts.range.end, opts.range.label)
    : resolveWindow(windowKey, nowMs);
  const u = supabase as unknown as UntypedClient;

  // A slow / missing source degrades to a neutral shape rather than sinking the
  // whole page — mirrors lib/tony/nodes.ts.
  const safe = <T>(p: PromiseLike<T>, fallback: T): Promise<T> =>
    Promise.resolve(p).then((v) => v, () => fallback);

  const thirtyDaysAgoIso = new Date(nowMs - 30 * DAY_MS).toISOString();
  const fourteenDaysAgoIso = new Date(nowMs - 14 * DAY_MS).toISOString();

  const [
    liveByBrand,
    signals,
    deptEfficiency,
    scoreboard,
    cashflow,
    departmentsRes,
    snapshotsRes,
    loopsRes,
    auditRes,
    feedRes,
  ] = await Promise.all([
    safe(getLiveDaysByBrand(supabase), new Map<string, BrandDay[]>()),
    safe(computeOrgSignals(supabase), null as Awaited<ReturnType<typeof computeOrgSignals>> | null),
    safe(computeDepartmentEfficiency(supabase), new Map() as Map<string, SignalValue>),
    safe(computeScoreboard(u, orgId), null as Awaited<ReturnType<typeof computeScoreboard>> | null),
    safe(loadCashflow(u, orgId, { horizonDays: 30 }), null as Awaited<ReturnType<typeof loadCashflow>> | null),
    safe(u.from("departments").select("id, name").order("name"), { data: [] as any[] }),
    safe(
      u
        .from("metrics_snapshots")
        .select("department_id, efficiency, quality_score, period_end")
        .not("department_id", "is", null)
        .order("period_end", { ascending: false }),
      { data: [] as any[] }
    ),
    // Active AI loops: distinct source_module among recently-drafted actions.
    safe(
      u.from("action_requests").select("source_module, created_at").gte("created_at", thirtyDaysAgoIso),
      { data: [] as any[] }
    ),
    // Workflow activity: audit events over the trailing window.
    safe(
      u.from("action_audit").select("event, created_at").gte("created_at", fourteenDaysAgoIso),
      { data: [] as any[] }
    ),
    // Executive feed: every pending request, full row (RLS-scoped to the org).
    safe(u.from("action_requests").select("*").eq("status", "pending"), { data: [] as any[] }),
  ]);

  // ── KPIs ──
  const health = (() => {
    if (!signals) return { value: null as number | null, basis: null as string | null };
    const parts: number[] = [];
    const basis: string[] = [];
    if (signals.efficiency.value != null) {
      parts.push(signals.efficiency.value);
      basis.push(`efficiency ${signals.efficiency.value}`);
    }
    if (signals.quality.value != null) {
      parts.push(signals.quality.value);
      basis.push(`quality ${signals.quality.value}`);
    }
    if (!parts.length) return { value: null, basis: null };
    return {
      value: round(parts.reduce((a, b) => a + b, 0) / parts.length),
      basis: basis.join(" · "),
    };
  })();

  // Revenue over the SELECTED window (defaults to MTD). The comparison window and
  // its label depend on the selection: month-based windows compare to the prior
  // month-to-date ("vs last month"); trailing windows compare to the immediately
  // preceding equal-length span ("vs prior 7d" / "vs prior 30d").
  const winAgg = orgWindow(liveByBrand, win.start, win.end);
  const isMonthWindow = !opts.range && (windowKey === "mtd" || windowKey === "month");
  // Prior window + its caption. With a custom range: honor an explicit Compare
  // window when the user chose one, else the equal-length preceding span. With a
  // preset window: the month-to-date pace (month windows) or the preceding span.
  const priorRange = opts.range
    ? opts.compareRange ?? precedingWindow(win)
    : isMonthWindow
    ? priorMonthToDate(nowMs)
    : precedingWindow(win);
  const priorAgg = orgWindow(liveByBrand, priorRange.start, priorRange.end);
  const revenueMtd = winAgg.gmv != null ? round(winAgg.gmv) : null;
  const revenueDeltaPct =
    winAgg.gmv != null && priorAgg.gmv != null && priorAgg.gmv > 0
      ? round(((winAgg.gmv - priorAgg.gmv) / priorAgg.gmv) * 100, 1)
      : null;
  const revenueDeltaLabel =
    revenueDeltaPct == null
      ? null
      : opts.range
      ? opts.compareLabel ?? "vs prior period"
      : isMonthWindow
      ? "vs last month"
      : windowKey === "last7"
      ? "vs prior 7d"
      : "vs prior 30d";

  const revenuePulse = buildRevenuePulse(liveByBrand, nowMs);
  const revenueSpark = revenuePulse.hasData ? revenuePulse.points.map((p) => p.gmv) : [];

  const cashFlow30d =
    cashflow?.forecast != null
      ? round(cashflow.forecast.endBalance - cashflow.forecast.startBalance)
      : null;
  const cashEndBalance = cashflow?.forecast != null ? round(cashflow.forecast.endBalance) : null;
  const cashAsOf = cashflow?.anchor?.as_of_date ?? null;

  const loopRows = (loopsRes.data ?? []) as { source_module: string | null }[];
  const loopSet = new Set<string>();
  for (const r of loopRows) if (r.source_module) loopSet.add(r.source_module);
  const activeLoops = loopRows.length > 0 ? loopSet.size : null;

  const kpis: Kpis = {
    currency: "PHP",
    health: health.value,
    healthBasis: health.basis,
    revenueMtd,
    revenueDeltaPct,
    revenueDeltaLabel,
    windowLabel: win.label,
    revenueSpark,
    cashFlow30d,
    cashEndBalance,
    cashAsOf,
    activeLoops,
    loopNames: Array.from(loopSet),
  };

  // ── Platform split (windowed) ──
  const platformSplit = buildPlatformSplit(liveByBrand, win);

  // ── Department health ──
  const departments = (departmentsRes.data ?? []) as { id: string; name: string }[];
  const snapshots = (snapshotsRes.data ?? []) as unknown as SnapshotRow[];
  const deptHealth = buildDeptHealth(departments, snapshots, deptEfficiency);

  // ── Workflow activity ──
  const audit = (auditRes.data ?? []) as unknown as AuditRow[];
  const workflow = buildWorkflowActivity(audit, nowMs);

  // ── Growth flywheel ──
  const flywheel: Flywheel = (() => {
    if (!scoreboard || scoreboard.pods.length === 0) {
      return {
        pods: 0,
        brandsUnderManagement: 0,
        actualPerPod: null,
        targetPerPod: null,
        hasData: false,
      };
    }
    const podCount = scoreboard.pods.length;
    const bum = scoreboard.org.brandsUnderManagement;
    const targets = scoreboard.pods.map((p) => p.targetBrands).filter((t): t is number => t != null);
    const targetPerPod = targets.length
      ? round(targets.reduce((a, b) => a + b, 0) / targets.length, 1)
      : null;
    return {
      pods: podCount,
      brandsUnderManagement: bum,
      actualPerPod: round(bum / podCount, 1),
      targetPerPod,
      hasData: true,
    };
  })();

  // ── Executive feed ──
  const pending = (feedRes.data ?? []) as unknown as ActionRequestRow[];
  const sortedPending = [...pending].sort(
    (a, b) => b.risk_tier - a.risk_tier || a.created_at.localeCompare(b.created_at)
  );
  const feed: ExecutiveFeed = {
    items: sortedPending.map((r) => ({ request: r, kind: feedKind(r) })),
    pendingTotal: pending.length,
  };

  const asOf = winAgg.gmv != null ? manilaStamp(new Date(nowMs).toISOString()) : null;

  return {
    kpis,
    revenuePulse,
    platformSplit,
    deptHealth,
    workflow,
    flywheel,
    feed,
    asOf,
  };
}
