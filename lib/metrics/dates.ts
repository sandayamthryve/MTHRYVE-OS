// Date-range presets for every metrics dashboard, computed deterministically
// from a caller-supplied "now" so server and client agree. All arithmetic is in
// the company timezone (Asia/Manila) to match the rest of the OS.

export type Preset =
  | "today"
  | "yesterday"
  | "last_7"
  | "last_30"
  | "mtd"
  | "qtd"
  | "ytd"
  | "custom";

export const PRESET_LABELS: Record<Preset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7: "Last 7 Days",
  last_30: "Last 30 Days",
  mtd: "MTD",
  qtd: "QTD",
  ytd: "YTD",
  custom: "Custom",
};

export type CompareMode = "none" | "previous" | "mom" | "wow" | "yoy";

export const COMPARE_LABELS: Record<CompareMode, string> = {
  none: "No compare",
  previous: "Previous period",
  mom: "Month over month",
  wow: "Week over week",
  yoy: "Year over year",
};

export interface Range {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

const MANILA_TZ = "Asia/Manila";
const DAY_MS = 24 * 60 * 60 * 1000;

// The Y/M/D as seen in Manila for a given instant, as a UTC-midnight Date we can
// do integer day math on without DST/offset drift (Manila has no DST, but this
// keeps the arithmetic offset-independent).
function manilaParts(now: Date): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function toDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function iso(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

function addDays(dt: Date, n: number): Date {
  return new Date(dt.getTime() + n * DAY_MS);
}

// Resolve a preset to a concrete [start, end] range using the given "now".
// `custom` falls back to whatever explicit start/end are supplied (or last_7).
export function resolvePreset(
  preset: Preset,
  now: Date,
  custom?: Partial<Range>
): Range {
  const { y, m, d } = manilaParts(now);
  const today = toDate(y, m, d);

  switch (preset) {
    case "today":
      return { start: iso(today), end: iso(today) };
    case "yesterday": {
      const yd = addDays(today, -1);
      return { start: iso(yd), end: iso(yd) };
    }
    case "last_7":
      return { start: iso(addDays(today, -6)), end: iso(today) };
    case "last_30":
      return { start: iso(addDays(today, -29)), end: iso(today) };
    case "mtd":
      return { start: iso(toDate(y, m, 1)), end: iso(today) };
    case "qtd": {
      const qStartMonth = m - ((m - 1) % 3);
      return { start: iso(toDate(y, qStartMonth, 1)), end: iso(today) };
    }
    case "ytd":
      return { start: iso(toDate(y, 1, 1)), end: iso(today) };
    case "custom":
      return {
        start: custom?.start || iso(addDays(today, -6)),
        end: custom?.end || iso(today),
      };
  }
}

// The comparison range for a resolved [start, end]. `previous` shifts back by
// the range length; wow/mom/yoy shift by a fixed calendar step. Returns null for
// 'none'. All in UTC-midnight day math (Manila offset is constant).
export function resolveCompare(range: Range, mode: CompareMode): Range | null {
  if (mode === "none") return null;
  const start = new Date(`${range.start}T00:00:00Z`);
  const end = new Date(`${range.end}T00:00:00Z`);

  if (mode === "previous") {
    const lenDays = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
    return {
      start: iso(addDays(start, -lenDays)),
      end: iso(addDays(end, -lenDays)),
    };
  }
  if (mode === "wow") {
    return { start: iso(addDays(start, -7)), end: iso(addDays(end, -7)) };
  }
  if (mode === "mom") {
    return { start: shiftMonths(range.start, -1), end: shiftMonths(range.end, -1) };
  }
  // yoy
  return { start: shiftMonths(range.start, -12), end: shiftMonths(range.end, -12) };
}

// Shift a YYYY-MM-DD by whole months, clamping the day to the target month's
// length (e.g. Mar 31 - 1mo => Feb 28/29).
function shiftMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return iso(toDate(ny, nm, nd));
}

const VALID_PRESETS: Preset[] = [
  "today",
  "yesterday",
  "last_7",
  "last_30",
  "mtd",
  "qtd",
  "ytd",
  "custom",
];
const VALID_COMPARE: CompareMode[] = ["none", "previous", "mom", "wow", "yoy"];

// Parse a preset from a query param, falling back to `fallback` when absent or
// invalid. The fallback is caller-chosen because different surfaces want a
// different default: range dashboards default to a trend window (last_7), while
// the daily metrics floor (where Quick-Entry writes a single-day row) defaults to
// "today" so a value recorded today is visible the moment analytics opens.
export function parsePreset(
  v: string | undefined | null,
  fallback: Preset = "last_7"
): Preset {
  return v && (VALID_PRESETS as string[]).includes(v) ? (v as Preset) : fallback;
}
export function parseCompare(v: string | undefined | null): CompareMode {
  return v && (VALID_COMPARE as string[]).includes(v) ? (v as CompareMode) : "none";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDate(v: string | undefined | null): v is string {
  return !!v && DATE_RE.test(v);
}
