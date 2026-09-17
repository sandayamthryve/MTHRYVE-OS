// HR time helpers — Manila-timezone date math plus the automated attendance
// computations (late / undertime / total hours) the Daily Logs module runs so
// nobody keys those numbers by hand. Every function is pure; the callers stamp
// the results onto the attendance row (or derive them at read time).

export const MANILA_TZ = "Asia/Manila";

// The org's default working schedule (Manila wall clock), applied to a day's
// attendance when no explicit scheduled_in/out has been set — so late /
// undertime compute automatically the moment someone clocks in. Leadership can
// still override the schedule per person/day on the Team worksheet.
export const DEFAULT_SCHEDULE = { in: "09:00", out: "18:00" } as const;

// Today in the company timezone, as YYYY-MM-DD — matches how AppShell derives
// the working day and avoids UTC drift on the server.
export function manilaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MANILA_TZ }).format(new Date());
}

// The first day of the current Manila month, as YYYY-MM-01.
export function manilaMonth(): string {
  return manilaToday().slice(0, 7);
}

export function isDate(s?: string): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function isMonth(s?: string): boolean {
  return !!s && /^\d{4}-\d{2}$/.test(s);
}

// Shift a YYYY-MM-DD string by whole days, computed in UTC so it never crosses a
// DST / local-midnight boundary.
export function shiftDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// The inclusive [first, last] day of a YYYY-MM month, as YYYY-MM-DD strings.
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

// A clock timestamptz rendered as a Manila wall-clock time (e.g. "09:14 AM").
export function fmtTime(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: MANILA_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(ts));
  } catch {
    return "—";
  }
}

// Minutes-since-midnight for a timestamptz, read on the Manila wall clock — so a
// punch is compared against the scheduled time in the same local frame.
function manilaMinutes(ts: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: MANILA_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(ts));
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  } catch {
    return null;
  }
}

// Minutes-since-midnight for a Postgres `time` value ("HH:MM" or "HH:MM:SS").
function scheduleMinutes(t: string | null): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

// Late = minutes the clock-in landed after the scheduled start (never negative).
// Null when either side is missing — we don't invent a zero we can't stand behind.
export function computeLateMinutes(
  scheduledIn: string | null,
  clockIn: string | null
): number | null {
  const s = scheduleMinutes(scheduledIn);
  const c = clockIn ? manilaMinutes(clockIn) : null;
  if (s == null || c == null) return null;
  return Math.max(0, c - s);
}

// Undertime = minutes the clock-out landed before the scheduled end.
export function computeUndertimeMinutes(
  scheduledOut: string | null,
  clockOut: string | null
): number | null {
  const s = scheduleMinutes(scheduledOut);
  const c = clockOut ? manilaMinutes(clockOut) : null;
  if (s == null || c == null) return null;
  return Math.max(0, s - c);
}

// Total hours actually worked, from the raw punch interval, to two decimals.
export function computeTotalHours(
  clockIn: string | null,
  clockOut: string | null
): number | null {
  if (!clockIn || !clockOut) return null;
  const ms = new Date(clockOut).getTime() - new Date(clockIn).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round((ms / 3_600_000) * 100) / 100;
}

// Render a minutes count as "1h 20m" / "45m" / "—".
export function fmtMinutes(min: number | null | undefined): string {
  const n = Number(min ?? 0);
  if (!n) return "—";
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
