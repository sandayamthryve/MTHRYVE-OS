// lib/snapfill/import.ts — SnapFill's shared bulk importer (CSV + XLSX).
//
// ONE parser for spreadsheet imports, accepting BOTH .csv and .xlsx (and .xlsm —
// macros ignored). It uses the SAME header→field-whitelist mapping as the drag/paste
// and photo paths (match.ts), so a CSV, an XLSX, and a snapped photo of the same
// list all land on the same columns with the same honest-null rules. It only maps
// whitelisted headers and ignores the rest.
//
// SECURITY — this module is SERVER-ONLY (imports exceljs / Node Buffer):
//   • every cell is treated as DATA — we read the workbook's CACHED computed value
//     of a formula cell, we NEVER evaluate a formula or run a macro (exceljs does
//     not execute either; .xlsm vbaProject is simply not read);
//   • file size and row count are capped, and an oversized file is rejected with a
//     clear message rather than being partially/again parsed;
//   • Excel serial dates are converted to real YYYY-MM-DD dates.
//
// It never writes to any table: it returns normalized records the caller inserts
// through its own already-role-gated, manual-lane write path.

import "server-only";
import ExcelJS from "exceljs";
import { mapRows, splitDelimited, toIsoDate } from "./match";
import type { SnapSchema } from "./schema";

// Guardrails. A lead/creator list is small; these are generous but bound abuse.
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMPORT_ROWS = 5000;

export interface SnapImportResult {
  records: Record<string, string>[];
  /** Header cells that matched no whitelisted field — reported, not imported. */
  ignoredHeaders: string[];
  /** Data rows that filled no whitelisted field (blank / all-unmatched). */
  skippedRows: number;
  /** True when the file exceeded MAX_IMPORT_ROWS and was truncated to the cap. */
  truncated: boolean;
  /** Total data rows seen (before the row cap). */
  totalRows: number;
  format: "csv" | "xlsx";
}

export type SnapImportError = { error: string };

// Detect the format from filename + declared MIME. Defaults to CSV for text.
function isXlsx(fileName: string, mime: string): boolean {
  const n = fileName.toLowerCase();
  if (n.endsWith(".xlsx") || n.endsWith(".xlsm") || n.endsWith(".xls")) return true;
  return (
    mime.includes("spreadsheetml") ||
    mime === "application/vnd.ms-excel" ||
    mime.includes("officedocument.spreadsheet")
  );
}

// Read one XLSX/XLSM cell to a plain string WITHOUT evaluating anything: for a
// formula cell we take exceljs's cached `result` (the value Excel last computed and
// stored), never the formula text; dates become YYYY-MM-DD; hyperlinks/rich text
// collapse to their text; a cached formula error becomes "" (honest blank).
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return toIsoDate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value.trim();

  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    // Formula cell: use the cached computed result, recursing so a formula that
    // yields a date/number/text is handled the same as a literal.
    if ("result" in v) {
      const r = v.result;
      if (r && typeof r === "object" && "error" in (r as Record<string, unknown>)) return "";
      return cellToString(r as ExcelJS.CellValue);
    }
    // Cached formula error (e.g. #DIV/0!) → honest blank, never fabricated.
    if ("error" in v) return "";
    // Hyperlink cell → its display text.
    if ("text" in v && typeof v.text === "string") return v.text.trim();
    // Rich text → concatenated runs.
    if ("richText" in v && Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((run) => run.text ?? "").join("").trim();
    }
  }
  return "";
}

// Parse a .xlsx/.xlsm buffer: first worksheet, header row = first non-empty row,
// data rows below it. Trailing empty rows are trimmed. Reads cached computed values
// only.
async function parseXlsx(buffer: Buffer, schema: SnapSchema): Promise<SnapImportResult | SnapImportError> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    return { error: "That spreadsheet couldn't be read. Re-save it as .xlsx or export a .csv and try again." };
  }
  const ws = wb.worksheets[0];
  if (!ws) return { error: "The workbook has no sheets to import." };

  // Collect rows as string matrices. exceljs row.values is 1-indexed (index 0 is
  // empty); normalize to a 0-based array.
  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values as ExcelJS.CellValue[]; // [ , c1, c2, ... ]
    const cells: string[] = [];
    for (let c = 1; c < vals.length; c++) cells.push(cellToString(vals[c]));
    // Trim wholly-empty rows (empty trailing rows included).
    if (cells.some((c) => c !== "")) matrix.push(cells);
  });

  if (matrix.length < 2) {
    return { error: "The sheet needs a header row and at least one data row." };
  }

  const header = matrix[0];
  const allData = matrix.slice(1);
  const totalRows = allData.length;
  const truncated = totalRows > MAX_IMPORT_ROWS;
  const dataRows = truncated ? allData.slice(0, MAX_IMPORT_ROWS) : allData;

  const { records, ignoredHeaders, skippedRows } = mapRows(header, dataRows, schema);
  return { records, ignoredHeaders, skippedRows, truncated, totalRows, format: "xlsx" };
}

// Parse a CSV/TSV body: header row + data rows, honouring quoted fields. Tab wins as
// the delimiter when present (spreadsheet copy), else comma.
function parseCsv(text: string, schema: SnapSchema): SnapImportResult | SnapImportError {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { error: "The file needs a header row and at least one data row." };
  }
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const header = splitDelimited(lines[0], delim);
  const allData = lines.slice(1).map((l) => splitDelimited(l, delim));
  const totalRows = allData.length;
  const truncated = totalRows > MAX_IMPORT_ROWS;
  const dataRows = truncated ? allData.slice(0, MAX_IMPORT_ROWS) : allData;

  const { records, ignoredHeaders, skippedRows } = mapRows(header, dataRows, schema);
  return { records, ignoredHeaders, skippedRows, truncated, totalRows, format: "csv" };
}

// Parse an uploaded import File against a field whitelist. Enforces the size cap up
// front, routes .xlsx/.xlsm to the exceljs path and everything else to CSV. Returns
// either the normalized records or a single clear error message.
export async function parseImportFile(
  file: File,
  schema: SnapSchema
): Promise<SnapImportResult | SnapImportError> {
  if (file.size === 0) return { error: "That file is empty." };
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      error: `That file is too large (max ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB). Split it into smaller files and try again.`,
    };
  }
  if (isXlsx(file.name, file.type || "")) {
    const buffer = Buffer.from(await file.arrayBuffer());
    return parseXlsx(buffer, schema);
  }
  const text = await file.text();
  return parseCsv(text, schema);
}

// Parse pasted CSV/TSV text (no file) against a whitelist — the textarea path.
export function parseImportText(text: string, schema: SnapSchema): SnapImportResult | SnapImportError {
  if (!text.trim()) return { error: "Paste some rows first." };
  return parseCsv(text, schema);
}

export function isImportError(r: SnapImportResult | SnapImportError): r is SnapImportError {
  return (r as SnapImportError).error !== undefined;
}
