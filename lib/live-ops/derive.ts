// lib/live-ops/derive.ts — the Live Operations aggregation layer.
//
// The Live Performance dashboard DERIVES every figure from already-filtered
// live_sessions rows. There is no parallel store: live metrics live in
// live_sessions only (One home per fact), and this module just rolls them up.
// It reuses lib/metrics/live.ts for the shared rules (weighted rates, live
// hours, GMV/hour, demographics) and adds the extra report fields the Live Ops
// cards need (viewers, likes, shares, comments, followers, retention, …).
//
// Honest nulls throughout: a card value is null unless at least one session in
// the set actually recorded that field. A null renders as "—", never a 0.

import {
  aggregateLive,
  sessionHours,
  type LiveAgg,
  type LiveSession,
} from "@/lib/metrics/live";

// Sum a nullable field across sessions. Returns null when NO session recorded
// it (so an untracked metric stays "—"), else the sum of the present values.
function sumOrNull(sessions: LiveSession[], pick: (s: LiveSession) => number | null): number | null {
  let total = 0;
  let any = false;
  for (const s of sessions) {
    const v = pick(s);
    if (v != null && Number.isFinite(Number(v))) {
      total += Number(v);
      any = true;
    }
  }
  return any ? total : null;
}

// Mean of the present values, or null when none recorded.
function meanOrNull(sessions: LiveSession[], pick: (s: LiveSession) => number | null): number | null {
  const vals: number[] = [];
  for (const s of sessions) {
    const v = pick(s);
    if (v != null && Number.isFinite(Number(v))) vals.push(Number(v));
  }
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Max of the present values, or null.
function maxOrNull(sessions: LiveSession[], pick: (s: LiveSession) => number | null): number | null {
  let m: number | null = null;
  for (const s of sessions) {
    const v = pick(s);
    if (v != null && Number.isFinite(Number(v))) m = m == null ? Number(v) : Math.max(m, Number(v));
  }
  return m;
}

// Normalise a stored rate to a 0..100 percentage for display. ≤1 is read as a
// ratio (0.045 → 4.5%); a larger value is already a percentage.
export function asPercent(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

export interface LiveOpsDerived {
  base: LiveAgg; // the shared roll-up (gmv, orders, ctr, ctor, live hours, …)

  // ── Sales ──
  gmv: number | null;
  totalSales: number | null;
  orders: number | null;
  aov: number | null; // gmv/orders when derivable, else mean of stored aov
  conversion: number | null; // 0..100, weighted orders/clicks else mean of stored

  // ── Audience ──
  impressions: number | null;
  viewers: number | null; // summed unique-ish viewers where recorded
  peakViewers: number | null; // max across sessions
  avgViewers: number | null;
  viewerRetention: number | null; // 0..100 mean

  // ── Engagement ──
  productClicks: number | null;
  ctr: number | null; // 0..100
  likes: number | null;
  shares: number | null;
  comments: number | null;
  engagementRate: number | null; // 0..100 mean
  newFollowers: number | null;
  returningViewers: number | null;

  // ── Live Session ──
  sessionCount: number;
  totalLiveHours: number | null;
  avgDurationMinutes: number | null;
  activeAnchors: number; // distinct anchor_id
  bestSession: { id: string; title: string | null; gmv: number } | null;
  bestProduct: string | null; // featured_products of the top-GMV session
}

export function deriveLiveOps(sessions: LiveSession[]): LiveOpsDerived {
  const base = aggregateLive(sessions);

  const gmv = sumOrNull(sessions, (s) => s.gmv);
  const orders = sumOrNull(sessions, (s) => s.orders);
  const totalSales = sumOrNull(sessions, (s) => s.total_sales);

  // AOV: prefer derived gmv/orders (the correct weighted value); fall back to
  // the mean of any stored per-session aov.
  const aov = gmv != null && orders != null && orders > 0 ? gmv / orders : meanOrNull(sessions, (s) => s.aov);

  // Conversion: weighted orders/clicks (base.ctor is the 0..1 ratio) when
  // counts exist, else the mean of stored conversion_rate.
  const conversion =
    base.ctor != null ? base.ctor * 100 : asPercent(meanOrNull(sessions, (s) => s.conversion_rate));

  // Distinct anchors that ran a session in this set.
  const anchorSet = new Set<string>();
  for (const s of sessions) if (s.anchor_id) anchorSet.add(s.anchor_id);

  // Best session by GMV (only among sessions that recorded a GMV).
  let bestSession: LiveOpsDerived["bestSession"] = null;
  for (const s of sessions) {
    if (s.gmv == null) continue;
    if (!bestSession || Number(s.gmv) > bestSession.gmv) {
      bestSession = { id: s.id, title: s.title, gmv: Number(s.gmv) };
    }
  }
  const bestProduct =
    (bestSession && sessions.find((s) => s.id === bestSession!.id)?.featured_products) || null;

  // Total live hours from the session-hours rule (duration_minutes or the
  // started→ended span); null when no session yielded an hour figure.
  let liveHours = 0;
  let anyHours = false;
  for (const s of sessions) {
    const h = sessionHours(s);
    if (h != null) {
      liveHours += h;
      anyHours = true;
    }
  }

  return {
    base,
    gmv,
    totalSales,
    orders,
    aov,
    conversion,
    impressions: sumOrNull(sessions, (s) => s.impressions),
    viewers: sumOrNull(sessions, (s) => s.viewers),
    peakViewers: maxOrNull(sessions, (s) => s.peak_viewers),
    avgViewers: meanOrNull(sessions, (s) => s.avg_viewers),
    viewerRetention: asPercent(meanOrNull(sessions, (s) => s.viewer_retention)),
    productClicks: sumOrNull(sessions, (s) => s.product_clicks),
    ctr: base.ctr != null ? base.ctr * 100 : null,
    likes: sumOrNull(sessions, (s) => s.likes),
    shares: sumOrNull(sessions, (s) => s.shares),
    comments: sumOrNull(sessions, (s) => s.comments),
    engagementRate: asPercent(meanOrNull(sessions, (s) => s.engagement_rate)),
    newFollowers: sumOrNull(sessions, (s) => s.new_followers),
    returningViewers: sumOrNull(sessions, (s) => s.returning_viewers),
    sessionCount: sessions.length,
    totalLiveHours: anyHours ? liveHours : null,
    avgDurationMinutes: meanOrNull(sessions, (s) => s.duration_minutes),
    activeAnchors: anchorSet.size,
    bestSession,
    bestProduct,
  };
}

// A per-day time series for the trend/line chart, attributed by Manila start
// day. Each point carries GMV, orders and viewers so the dashboard can plot a
// simple multi-series line. Days with no session are omitted (honest gaps).
export interface DayPoint {
  date: string; // YYYY-MM-DD (Manila)
  gmv: number | null;
  orders: number | null;
  viewers: number | null;
  sessions: number;
}
