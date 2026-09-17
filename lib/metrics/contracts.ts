// lib/metrics/contracts.ts — Reports-vs-Contract v2 attainment engine.
//
// A "contract" is a delivery commitment to a client (client_contracts). Its
// SCOPE OF WORK is a set of line items (contract_scope_items), each owned by a
// department and typed by what it delivers: gmv, content, live, ads or other.
// This module computes, for each scope item, the ACTUAL delivered vs the
// committed target over the contract's own [period_start, period_end] window —
// reading the SAME shared metrics layer every other surface uses so the numbers
// reconcile:
//   gmv     → live tiktok_shop_performance GMV (lib/metrics/gmv aggregate; the
//             retired brand_platform_metrics is no longer read)
//   content → content_items published in the window for the brand
//   live    → live_sessions hours / GMV (lib/metrics/live aggregateLive)
//   ads     → ad_spend vs the contract's monthly_ad_budget. The live commerce
//             source carries NO ad data, so this reads an honest "no data" ("—")
//             until a clean live ad pipe exists — never a stale bpm figure or a 0.
//   other   → manual status only (no automatic actual)
//
// Nothing is fabricated: a divide-by-zero yields null, a scope item with no
// target reads "no target set", and one with no matching rows reads "no data
// yet". RLS decides what the caller can read; this layer only shapes what it is
// handed. In particular the ad budget target is only supplied when the caller
// could read contract_financials — otherwise the money target is simply omitted.

import type { ResolvedWindow } from "./windows";
import { customWindow, todayManila } from "./windows";
import { aggregate, type BpmRow } from "./gmv";
import { aggregateLive, inWindow as liveInWindow, type LiveSession } from "./live";

export type DeliverableType = "gmv" | "content" | "live" | "ads" | "other";

export const DELIVERABLE_TYPES: DeliverableType[] = ["gmv", "content", "live", "ads", "other"];

export function isDeliverableType(v: string): v is DeliverableType {
  return (DELIVERABLE_TYPES as string[]).includes(v);
}

// ── Row shapes (these tables aren't in the generated Database types yet, so
// callers read them through the app's cast shim and hand the rows here). ───────

export interface ContractRow {
  id: string;
  org_id: string;
  brand_id: string | null;
  client_name: string | null;
  period_start: string | null; // YYYY-MM-DD
  period_end: string | null; // YYYY-MM-DD
  monthly_gmv_target: number | null;
  monthly_content_target: number | null;
  deliverables: unknown; // jsonb
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScopeItemRow {
  id: string;
  org_id: string;
  contract_id: string;
  department_id: string | null;
  brand_id: string | null;
  title: string;
  deliverable_type: string; // one of DeliverableType (defaults 'other')
  target_value: number | null;
  target_unit: string | null;
  project_id: string | null;
  status: string; // 'planned' | 'deployed' | ...
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinancialsRow {
  id: string;
  contract_id: string;
  monthly_fee: number | null;
  monthly_ad_budget: number | null;
  gross_margin_pct: number | null;
  notes: string | null;
}

// A trimmed content_items row — only what the content deliverable needs.
export interface ContentItemLite {
  brand_id: string | null;
  status: string | null;
  publish_date: string | null; // YYYY-MM-DD
}

// The content statuses that count as "delivered". Mirrors the content-calendar
// stage vocabulary (components/content-calendar/InlineStatusSelect).
const PUBLISHED_STATUSES = new Set(["published"]);

// ── Window + pace ─────────────────────────────────────────────────────────────

// The contract's own delivery window. Null when the dates aren't set — every
// windowed actual then reports "no data" honestly rather than guessing a range.
export function contractWindow(c: ContractRow): ResolvedWindow | null {
  if (!c.period_start || !c.period_end) return null;
  return customWindow(c.period_start, c.period_end, `${c.period_start} → ${c.period_end}`);
}

// Fraction 0..1 of the contract window elapsed as of `today` (Manila YYYY-MM-DD).
// Lexicographic date strings compare correctly; day-count gives the proportion.
export function elapsedFraction(
  start: string | null,
  end: string | null,
  today: string = todayManila()
): number {
  if (!start || !end) return 0;
  if (today <= start) return 0;
  if (today >= end) return 1;
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) return 1;
  return Math.min(1, Math.max(0, (t - s) / (e - s)));
}

// ── Attainment ────────────────────────────────────────────────────────────────

export type AttainmentFlag =
  | "on_track"
  | "behind"
  | "no_target"
  | "no_data"
  | "manual";

export interface Attainment {
  deliverableType: DeliverableType;
  target: number | null; // committed target (null = none set / not readable)
  actual: number | null; // delivered so far (null = nothing to measure)
  unit: string | null; // display unit ("GMV", "posts", "hours", …)
  isMoney: boolean; // whether target/actual are peso amounts
  attainmentPct: number | null; // actual / target * 100, guarded
  expectedPct: number | null; // pace: window elapsed * 100
  hasTarget: boolean;
  hasData: boolean;
  flag: AttainmentFlag;
  note: string; // honest one-line status label
}

// How lenient the pace check is before a scope item is flagged "behind":
// attainment may trail the elapsed-time pace by this many points and still read
// on-track, so a figure that's essentially keeping pace doesn't flap to red.
const PACE_GRACE_POINTS = 5;

export interface AttainmentInputs {
  item: ScopeItemRow;
  window: ResolvedWindow | null;
  bpmRows: BpmRow[]; // live commerce rows from tiktok_shop_performance (via fetchCommerceRows)
  liveSessions: LiveSession[]; // live_sessions rows (RLS-scoped)
  contentItems: ContentItemLite[]; // content_items rows (RLS-scoped)
  monthlyAdBudget: number | null; // from contract_financials, only if readable
  today?: string; // Manila YYYY-MM-DD (defaults to now)
}

const num = (v: number | null | undefined): number => (v == null ? 0 : Number(v));

// Does a live scope item's target measure hours or GMV? Read from the unit;
// anything money-flavoured means GMV, otherwise hours (the common live target).
function liveMode(unit: string | null): "hours" | "gmv" {
  const u = (unit ?? "").toLowerCase();
  if (/gmv|peso|php|₱|sales|revenue/.test(u)) return "gmv";
  return "hours";
}

// Compute one scope item's attainment from the pre-fetched rows. Pure — no I/O.
export function computeAttainment(inp: AttainmentInputs): Attainment {
  const { item, window } = inp;
  const type: DeliverableType = isDeliverableType(item.deliverable_type)
    ? item.deliverable_type
    : "other";
  const today = inp.today ?? todayManila();
  const elapsed = window
    ? elapsedFraction(window.start, window.end, today)
    : 0;
  const expectedPct = window ? Math.round(elapsed * 100) : null;

  // "other" is a manual line — no automatic actual, status carries the truth.
  if (type === "other") {
    return {
      deliverableType: type,
      target: item.target_value ?? null,
      actual: null,
      unit: item.target_unit ?? null,
      isMoney: false,
      attainmentPct: null,
      expectedPct,
      hasTarget: item.target_value != null,
      hasData: false,
      flag: "manual",
      note: "Tracked manually",
    };
  }

  // Resolve target, actual, unit and money-ness per deliverable type.
  let target: number | null = item.target_value ?? null;
  let actual: number | null = null;
  let hasData = false;
  let unit: string | null = item.target_unit ?? null;
  let isMoney = false;

  if (type === "gmv") {
    isMoney = true;
    unit = unit ?? "GMV";
    if (window && item.brand_id) {
      const agg = aggregate(inp.bpmRows, window, { brandId: item.brand_id });
      actual = agg.gmv;
      hasData = agg.hasData;
    }
  } else if (type === "content") {
    unit = unit ?? "posts";
    if (window && item.brand_id) {
      const start = window.start;
      const end = window.end;
      actual = inp.contentItems.filter(
        (c) =>
          c.brand_id === item.brand_id &&
          c.status != null &&
          PUBLISHED_STATUSES.has(c.status) &&
          c.publish_date != null &&
          c.publish_date >= start &&
          c.publish_date <= end
      ).length;
      // A count is real data even when it's zero — we can honestly say "0 of N".
      hasData = true;
    }
  } else if (type === "live") {
    const mode = liveMode(unit);
    isMoney = mode === "gmv";
    unit = unit ?? (mode === "gmv" ? "GMV" : "hours");
    if (window && item.brand_id) {
      const own = inp.liveSessions.filter(
        (s) => s.brand_id === item.brand_id && liveInWindow(s, window)
      );
      const agg = aggregateLive(own);
      actual = mode === "gmv" ? agg.gmv : agg.liveHours;
      hasData = mode === "gmv" ? agg.hasMetrics : agg.liveHours > 0;
    }
  } else if (type === "ads") {
    isMoney = true;
    unit = unit ?? "ad spend";
    // The budget target lives in contract_financials — only present when the
    // caller was allowed to read it. Otherwise there's no money target to show.
    target = inp.monthlyAdBudget != null ? inp.monthlyAdBudget : item.target_value ?? null;
    if (window && item.brand_id) {
      const agg = aggregate(inp.bpmRows, window, { brandId: item.brand_id });
      // Ad spend is only real when the source actually carried ad data. The live
      // commerce source (tiktok_shop_performance) does not, so this reads as an
      // honest "no data" ("—") rather than a fabricated 0% of the ad budget. There
      // is no clean live ad pipe yet; brand_platform_metrics is retired for reads.
      actual = agg.hasAdData ? agg.adSpend : null;
      hasData = agg.hasAdData;
    }
  }

  const hasTarget = target != null && Number(target) > 0;
  const attainmentPct =
    hasTarget && actual != null ? (num(actual) / Number(target)) * 100 : null;

  // Flag: no target → can't grade; no data → nothing delivered yet to grade;
  // otherwise compare attainment to the elapsed-time pace (with a small grace).
  let flag: AttainmentFlag;
  let note: string;
  if (!item.brand_id) {
    // Every automatic deliverable (gmv/content/live/ads) needs a brand to measure
    // against; "other" already returned above, so this only hits measurable types.
    flag = "no_data";
    note = "No brand linked";
  } else if (!hasTarget) {
    flag = "no_target";
    note = "No target set";
  } else if (!hasData) {
    flag = "no_data";
    note = "No data yet";
  } else if (attainmentPct == null) {
    flag = "no_data";
    note = "No data yet";
  } else {
    const pace = expectedPct ?? 100;
    const onTrack = attainmentPct >= pace - PACE_GRACE_POINTS;
    flag = onTrack ? "on_track" : "behind";
    note = `${Math.round(attainmentPct)}% of target · ${
      window ? `${expectedPct}% of window elapsed` : "full period"
    }`;
  }

  return {
    deliverableType: type,
    target,
    actual,
    unit,
    isMoney,
    attainmentPct,
    expectedPct,
    hasTarget,
    hasData,
    flag,
    note,
  };
}

// ── Rollups ───────────────────────────────────────────────────────────────────

// A scope item paired with its computed attainment.
export interface ScopeAttainment {
  item: ScopeItemRow;
  attainment: Attainment;
}

// Delivery risk for a contract/brand: how many of its measurable scope items are
// behind. Ranked highest-risk first for the org scorecard.
export interface DeliveryRisk {
  onTrack: number;
  behind: number;
  measured: number; // items with a gradeable on-track/behind verdict
  unmeasured: number; // no target / no data / manual
  total: number;
  behindPct: number | null; // behind / measured, guarded
  worst: number; // lowest attainment among behind items (for tiebreak), 0..100
}

export function deliveryRisk(items: ScopeAttainment[]): DeliveryRisk {
  let onTrack = 0;
  let behind = 0;
  let unmeasured = 0;
  let worst = 100;
  for (const { attainment } of items) {
    if (attainment.flag === "on_track") onTrack += 1;
    else if (attainment.flag === "behind") {
      behind += 1;
      if (attainment.attainmentPct != null) worst = Math.min(worst, attainment.attainmentPct);
    } else unmeasured += 1;
  }
  const measured = onTrack + behind;
  return {
    onTrack,
    behind,
    measured,
    unmeasured,
    total: items.length,
    behindPct: measured > 0 ? (behind / measured) * 100 : null,
    worst: behind > 0 ? worst : 100,
  };
}

// Sort key so the riskiest client sorts first: most behind items, then the
// highest behind-share, then the single worst-performing item.
export function riskSortValue(r: DeliveryRisk): number {
  return r.behind * 1_000_000 + (r.behindPct ?? 0) * 1000 + (100 - r.worst);
}
