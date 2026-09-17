// lib/snapfill/parse.ts — SnapFill's drag/paste parser (single record).
//
// Turns a blob of structured text (a spreadsheet row copied to the clipboard, a
// CSV/TSV snippet, or vertical "Label: value" lines) into { whitelisted key ->
// value } for ONE record, to fill a form. It maps input columns/labels onto the
// mount's field whitelist and IGNORES anything not on it. A value it can't parse
// for a field is omitted — honest nulls, never a fabricated 0 / "".
//
// Multi-row spreadsheet files (.csv / .xlsx) go through import.ts instead; both
// share the same header→field mapping in match.ts so a paste and an import land on
// the same columns.
//
// Pure + dependency-free so the "use client" component can run it inline.

import { coerceCell, matchField, mapRows, splitDelimited } from "./match";
import type { SnapSchema } from "./schema";

export interface SnapParseResult {
  values: Record<string, string>;
  filledKeys: string[];
  /** Input columns/labels that matched no whitelisted field (reported, not filled). */
  ignored: string[];
}

// Does a line look like a "Label: value" pair? (a single leading colon, some text
// on each side). Used to pick the vertical-form parser over the delimited one.
function looksLikeKeyValue(line: string): boolean {
  const idx = line.indexOf(":");
  return idx > 0 && idx < line.length - 1;
}

// Parse vertical "Label: value" lines (a copied contact card / list of fields).
// Later duplicates of a field don't overwrite an already-filled one.
function parseKeyValue(
  lines: string[],
  schema: SnapSchema,
  values: Record<string, string>,
  ignored: string[]
): void {
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const rawVal = line.slice(idx + 1);
    const field = matchField(key, schema);
    if (!field) {
      const label = key.trim();
      if (label) ignored.push(label);
      continue;
    }
    if (values[field.key] !== undefined) continue;
    const v = coerceCell(field, rawVal);
    if (v !== null) values[field.key] = v;
  }
}

// Parse a pasted/dropped text blob against a field whitelist. Tries, in order:
// vertical "Label: value" lines, then TAB-delimited (spreadsheet copy), then
// comma-delimited — whichever the text actually looks like. Only the first data
// row of delimited text is used — a paste fills one record.
export function parseStructuredText(text: string, schema: SnapSchema): SnapParseResult {
  const values: Record<string, string> = {};
  const ignored: string[] = [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { values, filledKeys: [], ignored };

  const kvLines = lines.filter(looksLikeKeyValue).length;
  const hasTab = lines.some((l) => l.includes("\t"));
  const hasComma = lines.some((l) => l.includes(","));

  const applyDelimited = (delim: string): boolean => {
    const header = splitDelimited(lines[0], delim);
    const dataRows = lines.slice(1, 2).map((l) => splitDelimited(l, delim));
    const { records, ignoredHeaders } = mapRows(header, dataRows, schema);
    if (ignoredHeaders.length === header.length) return false; // nothing matched — not a table
    ignored.push(...ignoredHeaders);
    const first = records[0];
    if (first) for (const [k, v] of Object.entries(first)) values[k] = v;
    return records.length > 0 || ignoredHeaders.length > 0;
  };

  // Vertical "Label: value" wins when most lines are pairs and it isn't obviously a
  // delimited table (a 2-column TSV row is handled below).
  if (kvLines >= Math.ceil(lines.length / 2) && !(lines.length >= 2 && hasTab)) {
    parseKeyValue(lines, schema, values, ignored);
  } else if (hasTab && lines.length >= 2 && applyDelimited("\t")) {
    // handled
  } else if (hasComma && lines.length >= 2 && applyDelimited(",")) {
    // handled
  } else {
    // Last resort: treat it as key:value lines even if sparse.
    parseKeyValue(lines, schema, values, ignored);
  }

  return {
    values,
    filledKeys: Object.keys(values),
    ignored: Array.from(new Set(ignored)),
  };
}
