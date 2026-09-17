// lib/live-ops/schedule.ts — Live schedule helpers: date ranges + conflict
// detection for the Live Operations calendar.
//
// The schedule IS live_sessions with status='scheduled' (the same rows the Plan
// calendar shows). Conflicts are computed from the session's planned window
// (started_at + expected_duration_minutes, falling back to duration_minutes or
// a default 60m): two sessions conflict when their windows OVERLAP and they
// share an anchor OR a studio.

import { manilaDateOf, type LiveSession } from "@/lib/metrics/live";
import { todayManila } from "@/lib/metrics/windows";

export type CalView = "day" | "week" | "month";

export function parseView(v: string | undefined | null): CalView {
  return v === "day" || v === "week" || v === "month" ? v : "month";
}

// True only for a REAL Manila calendar date in canonical YYYY-MM-DD form. The
// format regex alone is not enough: "2026-13-45" and "2026-02-31" match it but
// are not valid dates, and feeding them to rangeFor/addDays crashes at
// .toISOString(). The round-trip through manilaDateOf rejects any value the
// Date constructor silently rolls over (or can't parse at all).
export function isValidAnchor(ymd: string | null | undefined): boolean {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(`${ymd}T12:00:00+08:00`);
  return !Number.isNaN(d.getTime()) && manilaDateOf(d.toISOString()) === ymd;
}

// Coerce an untrusted ?date param to a valid anchor, else fall back to today in
// Manila. Guarantees a value that rangeFor/shiftDate can never crash on.
export function parseAnchor(date: string | null | undefined): string {
  return isValidAnchor(date) ? (date as string) : todayManila();
}

// A YYYY-MM-DD range (inclusive) for the given view anchored on `anchor`
// (YYYY-MM-DD, Manila). Month spans the whole calendar month; week is the
// Sun–Sat containing the anchor; day is the single day.
export interface DateRange {
  start: string;
  end: string;
  days: string[]; // every day in the range, ordered
  // For the month grid: the leading offset (weekday of the 1st, 0=Sun).
  gridStart: string; // the Sunday on/before start (month view)
  gridDays: string[]; // 42 days (6 weeks) for the month grid
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00+08:00`);
  // Guard: never call .toISOString() on an Invalid Date (throws RangeError).
  if (Number.isNaN(d.getTime())) return ymd;
  d.setDate(d.getDate() + n);
  return manilaDateOf(d.toISOString()) ?? ymd;
}

function weekdayOf(ymd: string): number {
  const day = new Date(`${ymd}T12:00:00+08:00`).getDay(); // 0=Sun..6=Sat (Manila noon)
  return Number.isNaN(day) ? 0 : day;
}

export function rangeFor(view: CalView, anchor: string): DateRange {
  // Defense in depth: an invalid anchor would crash the date math below, so
  // default to the current Manila period rather than compute from a bad value.
  if (!isValidAnchor(anchor)) anchor = todayManila();
  let start: string;
  let end: string;
  if (view === "day") {
    start = anchor;
    end = anchor;
  } else if (view === "week") {
    const wd = weekdayOf(anchor);
    start = addDays(anchor, -wd);
    end = addDays(start, 6);
  } else {
    // month
    const [y, m] = anchor.split("-").map(Number);
    start = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    end = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);

  const gridStart = addDays(start, -weekdayOf(start));
  const gridDays: string[] = [];
  for (let i = 0; i < 42; i++) gridDays.push(addDays(gridStart, i));

  return { start, end, days, gridStart, gridDays };
}

// The Manila calendar day a scheduled session lands on.
export function scheduleDay(s: LiveSession): string | null {
  return manilaDateOf(s.started_at) ?? manilaDateOf(s.created_at);
}

// Planned [startMs, endMs] for a session, or null when it has no start.
export function plannedWindow(s: LiveSession): { start: number; end: number } | null {
  if (!s.started_at) return null;
  const start = new Date(s.started_at).getTime();
  if (!Number.isFinite(start)) return null;
  const mins = s.expected_duration_minutes ?? s.duration_minutes ?? 60;
  return { start, end: start + mins * 60_000 };
}

export interface Conflict {
  a: LiveSession;
  b: LiveSession;
  reason: "anchor" | "studio";
}

// Detect overlapping-window conflicts within a set of scheduled sessions. Two
// sessions conflict when their planned windows overlap AND they share an anchor
// or a studio. Each unordered pair is reported once.
export function detectConflicts(sessions: LiveSession[]): Conflict[] {
  const out: Conflict[] = [];
  const withWindow = sessions
    .map((s) => ({ s, w: plannedWindow(s) }))
    .filter((x): x is { s: LiveSession; w: { start: number; end: number } } => x.w != null);

  for (let i = 0; i < withWindow.length; i++) {
    for (let j = i + 1; j < withWindow.length; j++) {
      const A = withWindow[i];
      const B = withWindow[j];
      const overlap = A.w.start < B.w.end && B.w.start < A.w.end;
      if (!overlap) continue;
      if (A.s.anchor_id && A.s.anchor_id === B.s.anchor_id) {
        out.push({ a: A.s, b: B.s, reason: "anchor" });
      } else if (A.s.studio && B.s.studio && A.s.studio.trim().toLowerCase() === B.s.studio.trim().toLowerCase()) {
        out.push({ a: A.s, b: B.s, reason: "studio" });
      }
    }
  }
  return out;
}

// The set of session ids that participate in at least one conflict.
export function conflictedIds(conflicts: Conflict[]): Set<string> {
  const s = new Set<string>();
  for (const c of conflicts) {
    s.add(c.a.id);
    s.add(c.b.id);
  }
  return s;
}
