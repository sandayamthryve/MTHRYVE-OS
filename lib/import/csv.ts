// lib/import/csv.ts — a small, dependency-free CSV reader/writer for the Bulk
// Import tool. It honours RFC-4180 double-quoted fields, including commas,
// newlines and "" escapes inside a quoted value, so a pasted or uploaded file
// with quoted notes/addresses parses into the right columns. Used by both the
// preview and the commit paths so a row is tokenised identically in each.

// Parse a whole CSV document into records of raw string fields. Fully blank
// lines are dropped. The first returned record is the header row (the caller
// decides that); no trimming is done here beyond stripping a trailing \r.
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let started = false; // has the current record any content (guards blank lines)

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    // Drop a record that is a single empty field (a blank line).
    if (!(record.length === 1 && record[0] === "")) {
      records.push(record);
    }
    record = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ",") {
      pushField();
      started = true;
    } else if (ch === "\n") {
      pushRecord();
    } else if (ch === "\r") {
      // swallow — \r\n and lone \r both end the record on the \n or here
      if (text[i + 1] !== "\n") pushRecord();
    } else {
      field += ch;
      started = true;
    }
  }
  // Flush the last field/record if the file didn't end with a newline.
  if (started || field !== "" || record.length > 0) {
    pushRecord();
  }
  return records;
}

// Quote a single value for CSV output: always wrapped so commas/quotes/newlines
// are safe, with embedded quotes doubled.
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

// Serialise a header + rows into a CRLF-delimited CSV string (Excel-friendly).
export function toCsv(headers: string[], rows: (unknown[])[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\r\n");
}

// Normalise a header cell to a comparison key: lower-cased, and every run of
// non-alphanumeric characters folded to a single underscore. So "Product Name",
// "product_name" and "product-name" all map to "product_name" for auto-mapping.
export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
