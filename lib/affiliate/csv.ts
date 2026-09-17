// lib/affiliate/csv.ts — a tiny, dependency-free CSV reader for the Sourcing
// bulk import. Header-driven so column order doesn't matter; only `name` (or an
// email) is required per row. Quoted fields honour embedded commas and ""
// escapes. Blank cells become null so the honest-null contract holds on import
// exactly as it does on the manual form.

export interface SourcingCsvRow {
  name: string | null;
  email: string | null;
  phone: string | null;
  platform: string | null;
  handle: string | null;
  category: string | null;
  follower_count: number | null;
}

export interface SourcingCsvParse {
  rows: SourcingCsvRow[];
  errors: string[];
}

function splitLine(line: string): string[] {
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
  return out.map((s) => s.trim());
}

// Map many friendly header spellings onto our canonical keys.
const HEADER_ALIASES: Record<string, keyof SourcingCsvRow> = {
  name: "name",
  creator: "name",
  "creator name": "name",
  "full name": "name",
  email: "email",
  "email address": "email",
  phone: "phone",
  mobile: "phone",
  "phone number": "phone",
  platform: "platform",
  handle: "handle",
  username: "handle",
  "@": "handle",
  category: "category",
  niche: "category",
  followers: "follower_count",
  "follower count": "follower_count",
  follower_count: "follower_count",
  reach: "follower_count",
};

function toIntOrNull(raw: string): number | null {
  const cleaned = raw.replace(/[,_\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function parseSourcingCsv(text: string): SourcingCsvParse {
  const errors: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { rows: [], errors: ["The file is empty."] };

  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const colMap = header.map((h) => HEADER_ALIASES[h] ?? null);
  if (!colMap.some((c) => c === "name" || c === "email")) {
    return {
      rows: [],
      errors: [
        'The header row needs at least a "name" or "email" column. Columns supported: name, email, phone, platform, handle, category, followers.',
      ],
    };
  }

  const rows: SourcingCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row: SourcingCsvRow = {
      name: null,
      email: null,
      phone: null,
      platform: null,
      handle: null,
      category: null,
      follower_count: null,
    };
    colMap.forEach((key, idx) => {
      if (!key) return;
      const raw = (cells[idx] ?? "").trim();
      if (!raw) return;
      if (key === "follower_count") row.follower_count = toIntOrNull(raw);
      else row[key] = raw;
    });
    // A row with neither a name nor an email carries no creator identity — skip
    // it rather than minting an anonymous row.
    if (!row.name && !row.email) {
      errors.push(`Row ${i + 1}: no name or email — skipped.`);
      continue;
    }
    if (!row.name && row.email) row.name = row.email;
    rows.push(row);
  }

  return { rows, errors };
}
