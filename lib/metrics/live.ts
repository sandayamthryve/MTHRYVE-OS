// lib/metrics/live.ts — the shared Live Selling metrics layer.
//
// TikTok Shop LIVE analytics run through here so every surface (the Live module
// dashboards, the per-anchor scorecard, the session detail funnel and Tony's
// Live node) agrees on exactly how a number is computed. The rules mirror the
// rest of the metrics layer: nothing is fabricated — a missing count yields the
// em-dash placeholder, and every rate/ratio guards divide-by-zero.
//
// Windows are resolved by lib/metrics/windows.ts (Asia/Manila), so "this month"
// selects the same sessions here as GMV does everywhere else. A session is
// attributed to a window by the Manila calendar date of its started_at (falling
// back to created_at for a session that was logged but never started).

import type { ResolvedWindow } from "@/lib/metrics/windows";

// The live_sessions row shape. The table isn't in the generated Database types
// yet, so callers read it through the same cast shim the rest of the app uses
// and hand the rows to these helpers.
export interface LiveSession {
  id: string;
  org_id: string;
  brand_id: string | null;
  anchor_id: string | null;
  platform: string;
  title: string | null;
  status: string; // 'scheduled' | 'live' | 'ended'
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number | null;
  gmv: number | null;
  attributed_gmv: number | null;
  units_sold: number | null;
  products_sold: number | null;
  impressions: number | null;
  clicks: number | null;
  orders: number | null;
  ctr: number | null;
  ctor: number | null;
  peak_viewers: number | null;
  avg_viewers: number | null;
  demographics: Demographics;
  external_id: string | null;
  source: string; // 'manual' | 'api'
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;

  // ── Live Operations additive fields (migration 0026) ──────────────────────
  // Session Information (report header). Every field is nullable — an
  // unrecorded value stays null (honest "—"), never a fabricated 0.
  session_number: string | null;
  moderator_id: string | null;
  team_leader_id: string | null;
  studio: string | null;
  shift: string | null;
  expected_duration_minutes: number | null;
  featured_products: string | null;
  // Standard-metrics fields the Daily Live Report adds beyond the originals.
  viewers: number | null;
  likes: number | null;
  shares: number | null;
  comments: number | null;
  new_followers: number | null;
  returning_viewers: number | null;
  product_clicks: number | null;
  viewer_retention: number | null; // stored ratio or percent (0..1 or 0..100)
  engagement_rate: number | null;
  total_sales: number | null;
  aov: number | null;
  conversion_rate: number | null;
  // Qualitative assessment + report lifecycle.
  assessment: Assessment | null;
  report_status: string; // 'draft' | 'submitted' | 'reviewed'
  report_submitted_at: string | null;
  report_submitted_by: string | null;
  report_reviewed_at: string | null;
  report_reviewed_by: string | null;
}

// The Session Assessment jsonb — rich qualitative notes captured on the report.
export type Assessment = {
  highlights?: string | null;
  challenges?: string | null;
  customer_insights?: string | null;
  competitor_obs?: string | null;
} | null;

// The registered live host.
export interface Anchor {
  id: string;
  org_id: string;
  name: string;
  handle: string | null;
  platform: string;
  anchor_type: string; // 'inhouse' | 'affiliate'
  creator_id: string | null;
  status: string; // 'active' | 'inactive'
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Demographics jsonb: a bucket→weight map per facet. Weights may be raw counts
// or percentages depending on the source; the rollup sums them and presents each
// bucket as a share of the facet total, so the mix is honest either way.
export type Demographics = {
  age?: Record<string, number> | null;
  gender?: Record<string, number> | null;
  location?: Record<string, number> | null;
} | null;

export type DemoFacet = "age" | "gender" | "location";

export interface DemoSlice {
  key: string;
  value: number; // summed weight across sessions
  pct: number; // 0..100 share of the facet total
}

export interface DemoRollup {
  age: DemoSlice[];
  gender: DemoSlice[];
  location: DemoSlice[];
  hasData: boolean;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

// YYYY-MM-DD in Asia/Manila for an ISO instant. en-CA yields the ISO date
// shape; the window compare is a plain lexicographic string compare (see
// windows.ts), so this is all we need to attribute a session to a window.
//
// Every part is zero-padded (`2-digit`) so the result is ALWAYS a canonical
// `YYYY-MM-DD`. This is load-bearing: callers compare these strings
// lexicographically against zero-padded window bounds ("2026-07-9" would sort
// after "2026-07-10"), and several re-parse the result via
// `new Date(\`${ymd}T12:00:00+08:00\`)` — which yields an Invalid Date for a
// non-padded day and then throws "RangeError: Invalid time value" at the next
// `.toISOString()`. Returns null (never throws) for a null/invalid instant.
export function manilaDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

// The Manila date a session counts toward: its start day, or the day it was
// logged if it never started.
export function sessionDate(s: LiveSession): string | null {
  return manilaDateOf(s.started_at) ?? manilaDateOf(s.created_at);
}

export function inWindow(s: LiveSession, win: ResolvedWindow): boolean {
  const d = sessionDate(s);
  return d != null && d >= win.start && d <= win.end;
}

// Normalise a stored rate to a 0..1 ratio. A value ≤ 1 is already a ratio; a
// larger value is read as a stored percentage (e.g. 4.5 → 0.045). Only used as
// the fallback when counts are absent — computed rates are always exact ratios.
function storedAsRatio(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n : n / 100;
}

// A rate computed from counts when both are present (guarding divide-by-zero),
// otherwise the stored rate. Returns a 0..1 ratio, or null when neither is
// available. `computed` tells the UI whether it came from live counts.
export interface Rate {
  value: number | null; // 0..1 ratio
  computed: boolean;
}

function rate(numerator: number | null, denominator: number | null, stored: number | null): Rate {
  if (numerator != null && denominator != null && denominator > 0) {
    return { value: numerator / denominator, computed: true };
  }
  return { value: storedAsRatio(stored), computed: false };
}

// CTR = clicks / impressions; CTOR = orders / clicks. Count-derived when the
// counts exist, else the stored rate.
export function sessionCtr(s: LiveSession): Rate {
  return rate(s.clicks, s.impressions, s.ctr);
}
export function sessionCtor(s: LiveSession): Rate {
  return rate(s.orders, s.clicks, s.ctor);
}

// Live hours for a session: duration_minutes when set, else the started→ended
// span. Null when the session hasn't ended and no duration was recorded — an
// in-progress session's elapsed time is shown live in the UI, not counted here.
export function sessionHours(s: LiveSession): number | null {
  if (s.duration_minutes != null) return Number(s.duration_minutes) / 60;
  if (s.started_at && s.ended_at) {
    const a = new Date(s.started_at).getTime();
    const b = new Date(s.ended_at).getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return (b - a) / 3_600_000;
  }
  return null;
}

// Elapsed live seconds for a session that is live right now (server seed for the
// client ticker). Null when it isn't live or has no start.
export function elapsedSeconds(s: LiveSession, nowMs: number = Date.now()): number | null {
  if (s.status !== "live" || !s.started_at) return null;
  const t = new Date(s.started_at).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

// The rolled-up figures for a set of already-filtered sessions.
export interface LiveAgg {
  sessions: number;
  gmv: number;
  attributedGmv: number;
  units: number;
  products: number;
  impressions: number;
  clicks: number;
  orders: number;
  liveHours: number;
  // Rates are computed from the summed counts (the correct weighted average),
  // falling back to the mean of stored rates when no counts exist. 0..1 ratios.
  ctr: number | null;
  ctor: number | null;
  peakViewers: number | null; // max across sessions
  avgViewers: number | null; // mean of per-session avg_viewers that have one
  gmvPerHour: number | null; // gmv / liveHours, guarded
  hasData: boolean; // any session at all
  hasMetrics: boolean; // any GMV/units/counts recorded
}

// Mean of the defined stored rates across sessions — the fallback when no counts
// are available to compute a weighted rate.
function meanStoredRate(sessions: LiveSession[], pick: (s: LiveSession) => number | null): number | null {
  const vals: number[] = [];
  for (const s of sessions) {
    const r = storedAsRatio(pick(s));
    if (r != null) vals.push(r);
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function aggregateLive(sessions: LiveSession[]): LiveAgg {
  let gmv = 0;
  let attributedGmv = 0;
  let units = 0;
  let products = 0;
  let impressions = 0;
  let clicks = 0;
  let orders = 0;
  let liveHours = 0;
  let peak: number | null = null;
  const avgViewerVals: number[] = [];
  let hasMetrics = false;

  for (const s of sessions) {
    if (s.gmv != null) { gmv += num(s.gmv); hasMetrics = true; }
    if (s.attributed_gmv != null) { attributedGmv += num(s.attributed_gmv); hasMetrics = true; }
    if (s.units_sold != null) { units += num(s.units_sold); hasMetrics = true; }
    if (s.products_sold != null) { products += num(s.products_sold); hasMetrics = true; }
    if (s.impressions != null) { impressions += num(s.impressions); hasMetrics = true; }
    if (s.clicks != null) { clicks += num(s.clicks); hasMetrics = true; }
    if (s.orders != null) { orders += num(s.orders); hasMetrics = true; }
    const h = sessionHours(s);
    if (h != null) liveHours += h;
    if (s.peak_viewers != null) peak = Math.max(peak ?? 0, num(s.peak_viewers));
    if (s.avg_viewers != null) avgViewerVals.push(num(s.avg_viewers));
  }

  // Weighted rates from summed counts; fall back to the mean stored rate.
  const ctr =
    impressions > 0 ? clicks / impressions : meanStoredRate(sessions, (s) => s.ctr);
  const ctor = clicks > 0 ? orders / clicks : meanStoredRate(sessions, (s) => s.ctor);

  return {
    sessions: sessions.length,
    gmv,
    attributedGmv,
    units,
    products,
    impressions,
    clicks,
    orders,
    liveHours,
    ctr,
    ctor,
    peakViewers: peak,
    avgViewers: avgViewerVals.length
      ? Math.round(avgViewerVals.reduce((a, b) => a + b, 0) / avgViewerVals.length)
      : null,
    gmvPerHour: liveHours > 0 ? gmv / liveHours : null,
    hasData: sessions.length > 0,
    hasMetrics,
  };
}

// Roll one demographics facet up across sessions: sum each bucket's weight, then
// express it as a share of the facet total. Buckets are returned largest-first.
function rollupFacet(sessions: LiveSession[], facet: DemoFacet): DemoSlice[] {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    const map = s.demographics?.[facet];
    if (!map || typeof map !== "object") continue;
    for (const [k, v] of Object.entries(map)) {
      const w = Number(v);
      if (!Number.isFinite(w) || w <= 0) continue;
      totals.set(k, (totals.get(k) ?? 0) + w);
    }
  }
  const sum = Array.from(totals.values()).reduce((a, b) => a + b, 0);
  if (sum <= 0) return [];
  return Array.from(totals.entries())
    .map(([key, value]) => ({ key, value, pct: (value / sum) * 100 }))
    .sort((a, b) => b.value - a.value);
}

export function rollupDemographics(sessions: LiveSession[]): DemoRollup {
  const age = rollupFacet(sessions, "age");
  const gender = rollupFacet(sessions, "gender");
  const location = rollupFacet(sessions, "location");
  return { age, gender, location, hasData: age.length + gender.length + location.length > 0 };
}

// A per-anchor scorecard row, ranked by GMV/hour.
export interface AnchorScore {
  anchor: Anchor;
  agg: LiveAgg;
  withTimestamps: number; // sessions carrying both started_at and ended_at
}

export function scoreAnchors(anchors: Anchor[], sessions: LiveSession[]): AnchorScore[] {
  return anchors
    .map((anchor) => {
      const own = sessions.filter((s) => s.anchor_id === anchor.id);
      const withTimestamps = own.filter((s) => s.started_at && s.ended_at).length;
      return { anchor, agg: aggregateLive(own), withTimestamps };
    })
    // Rank by GMV/hour desc; anchors without an hour figure sort to the bottom,
    // then by raw GMV as a tiebreak.
    .sort((a, b) => {
      const ah = a.agg.gmvPerHour ?? -1;
      const bh = b.agg.gmvPerHour ?? -1;
      if (bh !== ah) return bh - ah;
      return b.agg.gmv - a.agg.gmv;
    });
}

// Top anchors for a brand by GMV within the given (already brand-filtered)
// sessions — used by the per-brand dashboard.
export interface TopAnchor {
  anchorId: string;
  gmv: number;
  sessions: number;
}

export function topAnchorsByGmv(sessions: LiveSession[], limit = 5): TopAnchor[] {
  const byAnchor = new Map<string, { gmv: number; sessions: number }>();
  for (const s of sessions) {
    if (!s.anchor_id) continue;
    const cur = byAnchor.get(s.anchor_id) ?? { gmv: 0, sessions: 0 };
    cur.gmv += num(s.gmv);
    cur.sessions += 1;
    byAnchor.set(s.anchor_id, cur);
  }
  return Array.from(byAnchor.entries())
    .map(([anchorId, v]) => ({ anchorId, ...v }))
    .sort((a, b) => b.gmv - a.gmv)
    .slice(0, limit);
}

// Format a 0..1 rate ratio as a percentage string, or the em-dash when null.
export function ratePct(r: number | null | undefined, digits = 2): string {
  if (r == null) return "—";
  const v = Math.round(Number(r) * 100 * 10 ** digits) / 10 ** digits;
  return `${v}%`;
}

// Format live hours to one decimal, or the em-dash when null/zero-unknown.
export function hoursOrDash(h: number | null | undefined): string {
  if (h == null) return "—";
  return `${Math.round(Number(h) * 10) / 10}h`;
}
