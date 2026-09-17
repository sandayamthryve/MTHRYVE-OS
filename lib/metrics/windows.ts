// lib/metrics/windows.ts — the SINGLE source of truth for metric time windows.
//
// Every window is resolved in Asia/Manila (UTC+8, no DST), never UTC. The OS is
// a Philippine agency; "today", "this month" and "month-to-date" must mean the
// Manila calendar day/month regardless of where the server renders. Doing this
// in one place lets every GMV surface agree on exactly which rows a window
// selects, so the same window always shows the same total everywhere.
//
// A window is a pair of INCLUSIVE calendar dates (YYYY-MM-DD strings). Commerce
// rows are attributed to a window by their period_end (for the live
// tiktok_shop_performance source, period_end == the row's Manila stat_date), so a
// period that ends inside the window counts toward it. Lexicographic string compare
// on YYYY-MM-DD is a correct date compare, so callers filter with plain >= / <=.

export type WindowKey = "mtd" | "last7" | "last30" | "month";

export interface ResolvedWindow {
  key: WindowKey | "custom";
  start: string; // inclusive, YYYY-MM-DD (Asia/Manila)
  end: string; // inclusive, YYYY-MM-DD (Asia/Manila)
  label: string; // human label for the figure, e.g. "MTD", "Last 7 days"
}

export interface WindowProgress {
  // The natural period the window sits inside: the calendar month for
  // 'mtd'/'month', or the trailing N-day span for 'last7'/'last30'.
  dayOfPeriod: number; // 1-based day within the period (e.g. 11)
  totalDays: number; // days in the period (e.g. 31)
  daysElapsed: number; // days elapsed through today (== dayOfPeriod for MTD)
  pctElapsed: number; // 0..100, rounded
  // Pace projection is only meaningful for an in-progress calendar month.
  isProjectable: boolean;
}

// Asia/Manila is a fixed UTC+8 with no daylight saving, so a constant offset is
// exact — the same technique lib/tiktok/sync.ts relies on.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// The Manila calendar parts of a UTC instant. Shift by the fixed offset and read
// the UTC getters of the shifted instant — that yields Manila's wall clock.
function manilaParts(utcMs: number): { y: number; m: number; d: number } {
  const shifted = new Date(utcMs + MANILA_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(y: number, m0: number, d: number): string {
  return `${y}-${pad(m0 + 1)}-${pad(d)}`;
}

function daysInMonth(y: number, m0: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

// Start of "today" in Manila, expressed as a true UTC epoch ms — floor the
// Manila-shifted clock to a day boundary, then shift back.
function manilaTodayStartUtcMs(nowMs: number): number {
  return Math.floor((nowMs + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
}

/** Today in Asia/Manila as YYYY-MM-DD. */
export function todayManila(nowMs: number = Date.now()): string {
  const { y, m, d } = manilaParts(nowMs);
  return ymd(y, m, d);
}

/** Month-to-date: first day of the current Manila month → today (inclusive). */
export function monthToDate(nowMs: number = Date.now()): ResolvedWindow {
  const { y, m, d } = manilaParts(nowMs);
  return { key: "mtd", start: ymd(y, m, 1), end: ymd(y, m, d), label: "MTD" };
}

/** Trailing 7 days ending today (inclusive), Manila. */
export function last7(nowMs: number = Date.now()): ResolvedWindow {
  const todayStart = manilaTodayStartUtcMs(nowMs);
  const startParts = manilaParts(todayStart - 6 * DAY_MS);
  const endParts = manilaParts(todayStart);
  return {
    key: "last7",
    start: ymd(startParts.y, startParts.m, startParts.d),
    end: ymd(endParts.y, endParts.m, endParts.d),
    label: "Last 7 days",
  };
}

/** Trailing 30 days ending today (inclusive), Manila. */
export function last30(nowMs: number = Date.now()): ResolvedWindow {
  const todayStart = manilaTodayStartUtcMs(nowMs);
  const startParts = manilaParts(todayStart - 29 * DAY_MS);
  const endParts = manilaParts(todayStart);
  return {
    key: "last30",
    start: ymd(startParts.y, startParts.m, startParts.d),
    end: ymd(endParts.y, endParts.m, endParts.d),
    label: "Last 30 days",
  };
}

/** The full current calendar month (1st → last day), Manila. */
export function currentMonth(nowMs: number = Date.now()): ResolvedWindow {
  const { y, m } = manilaParts(nowMs);
  return {
    key: "month",
    start: ymd(y, m, 1),
    end: ymd(y, m, daysInMonth(y, m)),
    label: `${MONTH_NAMES[m]} ${y}`,
  };
}

/** Resolve a window key to its {start, end, label}. */
export function resolveWindow(key: WindowKey, nowMs: number = Date.now()): ResolvedWindow {
  switch (key) {
    case "mtd":
      return monthToDate(nowMs);
    case "last7":
      return last7(nowMs);
    case "last30":
      return last30(nowMs);
    case "month":
      return currentMonth(nowMs);
    default:
      return monthToDate(nowMs);
  }
}

// Coerce an untrusted string (e.g. a URL search param) to a valid WindowKey.
export function parseWindowKey(v: string | undefined | null, fallback: WindowKey = "mtd"): WindowKey {
  return v === "mtd" || v === "last7" || v === "last30" || v === "month" ? v : fallback;
}

// A custom [start, end] window (used where the user picks an arbitrary range,
// e.g. Finance), so those surfaces run through the same aggregation + collapse.
export function customWindow(start: string, end: string, label: string): ResolvedWindow {
  return { key: "custom", start, end, label };
}

// Elapsed-time progress for the active window's natural period. Drives the
// "MTD · Day 11 of 31 · 34% elapsed" strip and the pace projection.
export function windowProgress(key: WindowKey, nowMs: number = Date.now()): WindowProgress {
  const { y, m, d } = manilaParts(nowMs);
  if (key === "mtd" || key === "month") {
    const totalDays = daysInMonth(y, m);
    const daysElapsed = d; // through today, inclusive
    return {
      dayOfPeriod: d,
      totalDays,
      daysElapsed,
      pctElapsed: Math.round((daysElapsed / totalDays) * 100),
      isProjectable: daysElapsed < totalDays, // month still in progress
    };
  }
  const totalDays = key === "last7" ? 7 : 30;
  // A trailing window is, by definition, fully elapsed.
  return { dayOfPeriod: totalDays, totalDays, daysElapsed: totalDays, pctElapsed: 100, isProjectable: false };
}

// Format an ISO timestamp as an Asia/Manila "as of" stamp. Shared by every
// freshness label so they read identically across pages.
export function manilaStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 16).replace("T", " ");
  }
}

// ── ISO week windows (Asia/Manila) ────────────────────────────────────────────
//
// The affiliate performance standard is a WEEKLY bar, so it needs a Monday→Sunday
// ISO week resolved in Manila — the same fixed-offset technique the rest of this
// file uses. A week is returned as both inclusive calendar-day bounds (for
// display / date compares) and a half-open UTC-ms pair [startUtcMs, endUtcMs)
// so callers can filter a timestamptz column (creator_posts.posted_at) directly:
// a post counts toward the week when startUtcMs <= posted_at < endUtcMs.

export interface IsoWeekWindow {
  isoWeek: string; // "2026-W28" (ISO-8601 week-year + week number)
  start: string; // Monday, YYYY-MM-DD (Manila)
  end: string; // Sunday, YYYY-MM-DD (Manila)
  startUtcMs: number; // inclusive lower bound (Monday 00:00 Manila as UTC ms)
  endUtcMs: number; // EXCLUSIVE upper bound (next Monday 00:00 Manila as UTC ms)
  label: string; // e.g. "Jul 6 – Jul 12" for the freshness strip
}

// ISO week-year + week number for a Manila calendar date. Standard algorithm:
// the week's Thursday decides its owning year, and week 1 is the week containing
// Jan 4 (equivalently the first Thursday). Computed on a UTC "date-only" instant
// so no timezone re-shift sneaks in.
function isoWeekYearOf(y: number, m0: number, d: number): { year: number; week: number } {
  const date = new Date(Date.UTC(y, m0, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // move to this week's Thursday
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function shortDate(y: number, m0: number, d: number): string {
  return `${SHORT_MONTHS[m0]} ${d}`;
}

// The ISO week containing "today", shifted by `weekOffset` whole weeks
// (0 = current week to-date's week, -1 = last completed week for the Monday
// review). All boundaries are Manila Mondays.
export function isoWeekManila(nowMs: number = Date.now(), weekOffset = 0): IsoWeekWindow {
  const todayStart = manilaTodayStartUtcMs(nowMs); // Manila 00:00 today, as UTC ms
  const { y, m, d } = manilaParts(todayStart);
  const weekdayMon0 = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // Mon=0
  const mondayUtcMs = todayStart - weekdayMon0 * DAY_MS + weekOffset * 7 * DAY_MS;
  const sundayUtcMs = mondayUtcMs + 6 * DAY_MS;
  const endUtcMs = mondayUtcMs + 7 * DAY_MS;

  const mon = manilaParts(mondayUtcMs);
  const sun = manilaParts(sundayUtcMs);
  const thu = manilaParts(mondayUtcMs + 3 * DAY_MS);
  const { year, week } = isoWeekYearOf(thu.y, thu.m, thu.d);

  return {
    isoWeek: `${year}-W${pad(week)}`,
    start: ymd(mon.y, mon.m, mon.d),
    end: ymd(sun.y, sun.m, sun.d),
    startUtcMs: mondayUtcMs,
    endUtcMs,
    label: `${shortDate(mon.y, mon.m, mon.d)} – ${shortDate(sun.y, sun.m, sun.d)}`,
  };
}

// The current ISO week (Monday → today is the "to-date" span; the window itself
// still spans the full Mon–Sun so counts and idempotency keys are stable).
export function currentIsoWeekManila(nowMs: number = Date.now()): IsoWeekWindow {
  return isoWeekManila(nowMs, 0);
}

// The last completed ISO week — Monday review of the week that just ended.
export function lastCompletedIsoWeekManila(nowMs: number = Date.now()): IsoWeekWindow {
  return isoWeekManila(nowMs, -1);
}

// Coerce an untrusted param to a week selector. 'current' (default) vs 'last'.
export type WeekSelector = "current" | "last";
export function parseWeekSelector(v: string | undefined | null): WeekSelector {
  return v === "last" ? "last" : "current";
}

export function resolveIsoWeek(sel: WeekSelector, nowMs: number = Date.now()): IsoWeekWindow {
  return sel === "last" ? lastCompletedIsoWeekManila(nowMs) : currentIsoWeekManila(nowMs);
}
