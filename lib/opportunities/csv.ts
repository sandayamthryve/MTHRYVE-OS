// lib/opportunities/csv.ts — parsing for the Opportunity Engine's prospect list.
//
// The "Find Opportunities" panel lets a human paste, or upload, a plain list of
// prospects and rank them WITHOUT any paid lead source. This module turns that
// raw text into typed candidates. It reuses the leads CSV field-splitter so a
// value containing a comma stays intact, and it fabricates nothing: a blank cell
// becomes null (unknown), never a 0 or a false. A row missing a name is collected
// into `skipped` and reported, so one bad line never aborts the whole list.
//
// Header (order-independent — we map by column name, falling back to fixed order
// when there is no header row):
//   name, category, monthly_revenue, sells_online, has_tiktok_shop,
//   gmv_declining, runs_ads

import { parseCsvLine } from "@/lib/leads/csv";

// One prospect to be ranked. Only `name` is required; every other field is
// optional signal the engine may weigh. Booleans are tri-state: true / false /
// null(unknown) — an unknown signal is never guessed.
export interface OpportunityCandidate {
  name: string;
  category: string | null;
  monthly_revenue: number | null;
  sells_online: boolean | null;
  has_tiktok_shop: boolean | null;
  gmv_declining: boolean | null;
  runs_ads: boolean | null;
}

export type OpportunityCsvParse = { candidates: OpportunityCandidate[]; skipped: string[] };

// The canonical column order, surfaced so the panel and any template export show
// the same header without drifting.
export const OPPORTUNITY_CSV_COLUMNS = [
  "name",
  "category",
  "monthly_revenue",
  "sells_online",
  "has_tiktok_shop",
  "gmv_declining",
  "runs_ads",
] as const;

type ColumnKey = (typeof OPPORTUNITY_CSV_COLUMNS)[number];

// Parse a numeric cell (revenue) to a number, or null when blank/invalid.
// Tolerates thousands separators and a leading currency symbol so a pasted
// "₱1,200,000" or "$45k" degrades sensibly rather than becoming NaN.
export function parseRevenue(raw: string): number | null {
  let t = (raw ?? "").trim();
  if (t === "") return null;
  const kilo = /k$/i.test(t);
  const mega = /m$/i.test(t);
  t = t.replace(/[₱$€£,\s]/g, "").replace(/[km]$/i, "");
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const scaled = kilo ? n * 1_000 : mega ? n * 1_000_000 : n;
  return scaled;
}

// Parse a tri-state boolean signal. yes/y/true/1/✓ → true; no/n/false/0 → false;
// anything blank/unrecognised → null (unknown), so we never assert a signal we
// don't actually have.
export function parseTriBool(raw: string): boolean | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "") return null;
  if (["yes", "y", "true", "t", "1", "✓", "✔"].includes(t)) return true;
  if (["no", "n", "false", "f", "0", "✗", "✘", "-"].includes(t)) return false;
  return null;
}

// Given a first row's cells, decide whether it's a HEADER and, if so, map each
// known column key to its index. A row is treated as a header when it names at
// least two of our known columns (so columns can appear in any order, or a
// subset), and it must include a `name` column — that's the one required field.
// Returns null when the row looks like data, so the caller falls back to fixed
// positional order. This keeps a plain positional paste working while also
// honouring a reordered / partial header a human is likely to paste.
function headerIndex(cells: string[]): Record<ColumnKey, number> | null {
  const normalized = cells.map((c) => c.trim().toLowerCase().replace(/\s+/g, "_"));
  const known = new Set<string>(OPPORTUNITY_CSV_COLUMNS);
  const matched = normalized.filter((c) => known.has(c));
  if (matched.length < 2 || !normalized.includes("name")) return null;
  const idx = {} as Record<ColumnKey, number>;
  for (const key of OPPORTUNITY_CSV_COLUMNS) {
    idx[key] = normalized.indexOf(key);
  }
  return idx;
}

// Parse a full CSV/paste body into candidates. The first row is treated as a
// header when its first cell is "name" (columns then map by name, so the order
// is flexible); otherwise every row is data mapped by fixed position. A row with
// no name is collected into `skipped` rather than thrown.
export function parseOpportunityCsv(text: string): OpportunityCsvParse {
  const skipped: string[] = [];
  const candidates: OpportunityCandidate[] = [];
  if (!text.trim()) return { candidates, skipped };

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { candidates, skipped };

  const firstCells = parseCsvLine(lines[0]);
  const idx = headerIndex(firstCells);
  const dataLines = idx ? lines.slice(1) : lines;

  const at = (cols: string[], key: ColumnKey): string => {
    const i = idx ? idx[key] : OPPORTUNITY_CSV_COLUMNS.indexOf(key);
    if (i < 0) return "";
    return (cols[i] ?? "").trim();
  };

  for (const raw of dataLines) {
    const cols = parseCsvLine(raw);
    const name = at(cols, "name");
    if (!name) {
      skipped.push("missing name (blank row)");
      continue;
    }
    candidates.push({
      name,
      category: at(cols, "category") || null,
      monthly_revenue: parseRevenue(at(cols, "monthly_revenue")),
      sells_online: parseTriBool(at(cols, "sells_online")),
      has_tiktok_shop: parseTriBool(at(cols, "has_tiktok_shop")),
      gmv_declining: parseTriBool(at(cols, "gmv_declining")),
      runs_ads: parseTriBool(at(cols, "runs_ads")),
    });
  }

  return { candidates, skipped };
}
