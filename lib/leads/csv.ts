// lib/leads/csv.ts — shared CSV parsing for lead imports.
//
// One home for the leads import format so the Leads/CRM page and the BizDev
// Outreach board read the same file identically. Nothing here fabricates a
// value: a blank cell becomes null (unknown), never a zero, and a row missing a
// name is collected into `skipped` rather than thrown — one malformed line never
// aborts the whole file.

// The normalized shape of one imported lead row. Org/user columns are added by
// the caller (from the session), so this stays a pure data mapping.
export type LeadCsvRow = {
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  department: string | null;
  stage: string;
  value: number | null;
  notes: string | null;
};

export type LeadCsvParse = { rows: LeadCsvRow[]; skipped: string[] };

// The fixed column order for the leads CSV. Surfaced so import controls and
// template exports can render the same header without drifting.
export const LEAD_CSV_COLUMNS = [
  "name",
  "company",
  "email",
  "phone",
  "source",
  "department",
  "stage",
  "value",
  "notes",
] as const;

// Split one CSV line into fields, honouring double-quoted fields (so a value
// containing a comma stays in one column) and "" as an escaped quote. Embedded
// newlines inside a quoted field aren't supported — the import is line-based.
export function parseCsvLine(line: string): string[] {
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
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Parse an estimated value to a number, or null when blank/invalid — an unknown
// value is never fabricated as 0.
export function toNumOrNull(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Parse a full CSV body into normalized lead rows. Header:
// name,company,email,phone,source,department,stage,value,notes.
// Every row is processed; a bad row (missing name) is collected into `skipped`
// rather than throwing. The header row (first cell === "name") is skipped.
export function parseLeadsCsv(text: string): LeadCsvParse {
  const skipped: string[] = [];
  const rows: LeadCsvRow[] = [];
  if (!text.trim()) return { rows, skipped };

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue; // blank line
    const cols = parseCsvLine(raw);
    const name = (cols[0] ?? "").trim();
    if (name.toLowerCase() === "name") continue; // header row
    if (!name) {
      skipped.push("missing name (blank row)");
      continue;
    }
    rows.push({
      name,
      company: (cols[1] ?? "").trim() || null,
      email: (cols[2] ?? "").trim() || null,
      phone: (cols[3] ?? "").trim() || null,
      source: (cols[4] ?? "").trim() || null,
      department: (cols[5] ?? "").trim() || null,
      stage: (cols[6] ?? "").trim() || "new",
      value: toNumOrNull((cols[7] ?? "").trim()),
      notes: (cols[8] ?? "").trim() || null,
    });
  }
  return { rows, skipped };
}
