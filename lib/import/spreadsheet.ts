// lib/import/spreadsheet.ts — the spreadsheet half of the Bulk Import reader.
//
// The Bulk Import tool (/imports) historically accepted only CSV. This module adds
// XLSX / XLS support WITHOUT a second import path: it turns an uploaded spreadsheet
// into the SAME `string[][]` matrix that lib/import/csv.parseCsv() produces, and the
// caller feeds that one matrix into the one classify → preview → commit pipeline. So
// a CSV and an XLSX of the same data are byte-identical by the time they are
// classified, and produce identical rows.
//
// SECURITY / honesty — this module is SERVER-ONLY (imports exceljs + Node Buffer),
// and mirrors lib/snapfill/import.ts's hard rules:
//   • every cell is DATA: for a formula cell we read exceljs's CACHED computed value,
//     we NEVER evaluate a formula or run a macro (.xlsm vbaProject is not read);
//   • a cached formula error becomes "" (an honest blank), never a fabricated value;
//   • Excel serial dates become real YYYY-MM-DD strings;
//   • PDF and image uploads are REFUSED with a clear message — we never attempt table
//     extraction from a PDF, because a plausible-looking misparse is worse than a
//     rejected file.

import "server-only";
import ExcelJS from "exceljs";

// Reject message for PDF uploads — the exact copy the product asked for.
export const PDF_REJECT_MESSAGE =
  "PDF isn't accepted — export as CSV or Excel from Seller Center.";
// Parallel copy for images (screenshots of a dashboard, etc.).
export const IMAGE_REJECT_MESSAGE =
  "Images aren't accepted — export as CSV or Excel from Seller Center.";

// Byte cap for an uploaded import file. Generous for a creator/affiliate list but a
// hard bound on a pathological upload before exceljs ever opens it.
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024; // 8 MB

export type TabularFormat = "csv" | "xlsx";

// How an uploaded file should be handled, decided from its name + declared MIME.
export type FileKind =
  | { kind: "spreadsheet" }
  | { kind: "csv" }
  | { kind: "reject"; message: string };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg|avif)$/i;
const SPREADSHEET_EXT = /\.(xlsx|xlsm|xls)$/i;

// Classify an upload before reading a single byte of its body. Extension wins when
// present (a mislabelled MIME is common); MIME is the fallback. Anything that is not
// a recognised spreadsheet or an explicit reject falls through to the CSV/text path.
export function classifyUpload(fileName: string, mime: string): FileKind {
  const name = (fileName || "").toLowerCase();
  const type = (mime || "").toLowerCase();

  if (name.endsWith(".pdf") || type === "application/pdf") {
    return { kind: "reject", message: PDF_REJECT_MESSAGE };
  }
  if (IMAGE_EXT.test(name) || type.startsWith("image/")) {
    return { kind: "reject", message: IMAGE_REJECT_MESSAGE };
  }
  if (
    SPREADSHEET_EXT.test(name) ||
    type.includes("spreadsheetml") ||
    type === "application/vnd.ms-excel" ||
    type.includes("officedocument.spreadsheet")
  ) {
    return { kind: "spreadsheet" };
  }
  return { kind: "csv" };
}

// Collapse one exceljs cell to a plain string WITHOUT evaluating anything. Formula
// cells yield their cached result; dates become YYYY-MM-DD; hyperlinks/rich text
// collapse to their text; a cached formula error becomes "".
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return toIsoDate(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value.trim();

  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("result" in v) {
      const r = v.result;
      if (r && typeof r === "object" && "error" in (r as Record<string, unknown>)) return "";
      return cellToString(r as ExcelJS.CellValue);
    }
    if ("error" in v) return "";
    if ("text" in v && typeof v.text === "string") return v.text.trim();
    if ("richText" in v && Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((run) => run.text ?? "").join("").trim();
    }
  }
  return "";
}

// A Date → YYYY-MM-DD in UTC (exceljs returns serial dates as UTC Dates).
function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Parse an .xlsx/.xlsm/.xls buffer into a raw string matrix: first worksheet, all
// non-empty rows (header first, decided by the caller). Reads cached values only.
// Throws a caller-friendly Error when exceljs cannot open the workbook — a genuine
// legacy binary .xls it cannot read is REJECTED with a re-save hint, never guessed
// at.
export async function parseSpreadsheet(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    throw new Error(
      "That spreadsheet couldn't be read. Re-save it as .xlsx, or export a .csv from Seller Center, and try again."
    );
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The workbook has no sheets to import.");

  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values as ExcelJS.CellValue[]; // [ , c1, c2, ... ] (1-indexed)
    const cells: string[] = [];
    for (let c = 1; c < vals.length; c++) cells.push(cellToString(vals[c]));
    if (cells.some((c) => c !== "")) matrix.push(cells);
  });
  return matrix;
}
