// lib/snapfill/match.ts — the ONE header/label → field-whitelist mapping.
//
// Shared by every SnapFill input path so they map identically: the single-record
// paste parser (parse.ts), the multi-row CSV/XLSX bulk importer (import.ts), and
// (implicitly, via the same field labels) the vision reader. Keeping the map in one
// place is what lets "drag/paste a row", "snap a photo", and "import a spreadsheet"
// all land on the same columns with the same honest-null rules.
//
// Pure + dependency-free (no server or React imports).

import { isNumericField, type SnapField, type SnapFieldType, type SnapSchema } from "./schema";

// Normalize a header/label token for fuzzy matching: lowercase, strip everything
// that isn't a letter or digit. "Follower Count" / "follower_count" / "followers"
// collapse toward comparable forms.
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Match one input token (a header cell or a "Label:" key) to a whitelisted field.
// Exact normalized match on key/label/alias wins; a loose contains-match is the
// fallback so "gmv (php)" still finds the "gmv" field. Returns null for anything
// off the whitelist — the caller then IGNORES that column (honest).
export function matchField(token: string, schema: SnapSchema): SnapField | null {
  const n = norm(token);
  if (!n) return null;
  const candidatesFor = (f: SnapField) =>
    [f.key, f.label, ...(f.aliases ?? [])].map(norm).filter(Boolean);

  for (const f of schema) {
    if (candidatesFor(f).includes(n)) return f;
  }
  for (const f of schema) {
    if (candidatesFor(f).some((c) => c.length >= 3 && (c.includes(n) || n.includes(c)))) return f;
  }
  return null;
}

// Coerce a raw cell string to the value we store for a field, or null to OMIT it
// (honest nulls — never a fabricated 0 / ""). Numbers must parse as a real number
// or drop to null; dates are normalized to YYYY-MM-DD; other text is trimmed and
// kept verbatim (a @handle / URL / number-as-text is not reformatted). Garbage
// NEVER lands in a field: a value with control/binary characters (e.g. the raw
// "PK…" ZIP bytes of a mis-read spreadsheet) or one past a sane length cap is
// rejected up front, and a numeric field never accepts letters/binary "stripped"
// down to stray digits.
export function coerceCell(field: SnapField, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "—") return null;

  // Reject binary / non-printable / absurdly long values in EVERY mode before any
  // field-specific handling — this is the single guard that keeps ZIP bytes and
  // control characters out of the form.
  if (!isSaneValue(trimmed)) return null;

  const type: SnapFieldType = field.type ?? "text";
  if (isNumericField(field)) {
    return parseNumericStrict(trimmed);
  }
  if (type === "date") {
    return normalizeDate(trimmed);
  }
  return trimmed;
}

// A value is "sane" to fill a field with when it is printable (no control /
// binary characters other than ordinary whitespace) and within a reasonable
// length. The control-char check is what catches a spreadsheet read as raw bytes
// ("PK\x03\x04…"): those contain NULs and other control codes and are rejected.
export const MAX_VALUE_LEN = 500;
// C0/C1 control chars except TAB(9)/LF(10)/CR(13), plus DEL(127).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
export function isSaneValue(s: string): boolean {
  if (s.length > MAX_VALUE_LEN) return false;
  if (CONTROL_CHARS.test(s)) return false;
  return true;
}

// Strict numeric parse: strip currency symbols, thousands separators, and a single
// trailing percent, then REQUIRE what remains to be a plain number. "₱1,234.50" ->
// "1234.5", "12.3%" -> "12.3"; but "abc", "PK\x03\x04…", or "12ab" -> null (never a
// bogus number salvaged from garbage).
export function parseNumericStrict(raw: string): string | null {
  const t = raw.replace(/[₱$€£¥,\s]/g, "").replace(/%$/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : null;
}

// Best-effort date normalization to YYYY-MM-DD. Accepts an ISO string, a common
// M/D/Y, or a Date already stringified upstream. Returns null if it can't be read
// as a date (honest — never a fabricated date).
export function normalizeDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return toIsoDate(parsed);
}

// Format a Date as a UTC YYYY-MM-DD (dates carry no time-of-day meaning here).
export function toIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// Split one delimited line, honouring double-quoted fields ("a, b" stays one cell,
// "" is an escaped quote). Embedded newlines inside a quoted field aren't supported
// — the parsers are line-based.
export function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Map a header row + a matrix of data rows onto the field whitelist. Shared by the
// CSV and XLSX importers so both produce identical records. A header that matches
// no whitelisted field is recorded in `ignoredHeaders` and its column dropped; a
// row that fills no field is counted in `skippedRows`.
export function mapRows(
  header: string[],
  dataRows: string[][],
  schema: SnapSchema
): { records: Record<string, string>[]; ignoredHeaders: string[]; skippedRows: number } {
  const mapped = header.map((h) => matchField(h, schema));
  const ignoredHeaders = Array.from(
    new Set(header.filter((h, i) => !mapped[i] && h.trim()).map((h) => h.trim()))
  );

  const records: Record<string, string>[] = [];
  let skippedRows = 0;
  for (const row of dataRows) {
    const values: Record<string, string> = {};
    header.forEach((_h, i) => {
      const field = mapped[i];
      if (!field) return;
      if (values[field.key] !== undefined) return;
      const v = coerceCell(field, row[i] ?? "");
      if (v !== null) values[field.key] = v;
    });
    if (Object.keys(values).length === 0) {
      skippedRows += 1;
      continue;
    }
    records.push(values);
  }
  return { records, ignoredHeaders, skippedRows };
}
