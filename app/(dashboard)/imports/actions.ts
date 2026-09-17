"use server";

// Server actions for the CSV Bulk Import tool. Two phases:
//   previewImport — parse the file, auto-map (or accept the operator's mapping),
//                   validate every row and flag valid / errors / duplicates. No
//                   writes. The raw CSV is echoed back so the confirm step
//                   re-submits the exact same bytes with the chosen mapping.
//   commitImport  — re-run the same classification against the CURRENT database
//                   (so a row that became a duplicate since preview is still
//                   caught), insert only the valid rows, write ONE import_batches
//                   audit row, and return the counts + the error report. Invalid
//                   and duplicate rows are never written and never dropped
//                   silently — they come back as the downloadable report.
//
// Access: the page + these actions gate by canImport(); table RLS is the real
// backstop. A user who can't commit an entity gets a clear message, not a write.

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { parseCsv, toCsv } from "@/lib/import/csv";
import { classifyUpload, parseSpreadsheet, MAX_IMPORT_BYTES } from "@/lib/import/spreadsheet";
import { IMPORTERS, autoMap, ENTITY_ORDER, type EntityType } from "@/lib/import/registry";
import {
  buildPreview,
  canImport,
  capLines,
  classify,
  commitRows,
  detectHeaderRow,
  loadContext,
  missingRequiredColumns,
  reportRows,
  resolveProductBrands,
  MAX_ROWS,
  type Shim,
} from "@/lib/import/engine";
import type { PreviewState, CommitState, ColumnMeta } from "./types";

function parseEntity(v: FormDataEntryValue | null): EntityType | null {
  const s = String(v ?? "");
  return (ENTITY_ORDER as string[]).includes(s) ? (s as EntityType) : null;
}

type TabularRead =
  | { ok: true; records: string[][]; fileName?: string; fileSize?: number }
  | { ok: false; error: string };

// Read whatever the operator gave us into ONE `string[][]` matrix, whatever the
// format. CSV, XLSX and XLS all converge here so a single classify → preview →
// commit pipeline runs downstream — there is no second import path. PDF and image
// uploads are REFUSED with a clear message; a legacy spreadsheet exceljs cannot open
// is refused too. Precedence: a freshly uploaded file, then the pasted textarea,
// then the echoed canonical CSV carried from preview into re-preview / commit.
async function readTabular(formData: FormData): Promise<TabularRead> {
  const file = formData.get("file");
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > MAX_IMPORT_BYTES) {
      return {
        ok: false,
        error: `That file is too large (max ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB). Split it into smaller files and try again.`,
      };
    }
    const kind = classifyUpload(file.name, file.type || "");
    if (kind.kind === "reject") return { ok: false, error: kind.message };
    if (kind.kind === "spreadsheet") {
      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const records = await parseSpreadsheet(buffer);
        return { ok: true, records, fileName: file.name, fileSize: file.size };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "That spreadsheet couldn't be read." };
      }
    }
    return { ok: true, records: parseCsv(await file.text()), fileName: file.name, fileSize: file.size };
  }
  const pasted = formData.get("pasted");
  if (typeof pasted === "string" && pasted.trim()) {
    return { ok: true, records: parseCsv(pasted) };
  }
  const echoed = formData.get("csv");
  if (typeof echoed === "string" && echoed.trim()) {
    const name = String(formData.get("fileName") ?? "") || undefined;
    const size = Number(formData.get("fileSize") ?? 0) || undefined;
    return { ok: true, records: parseCsv(echoed), fileName: name, fileSize: size };
  }
  return { ok: false, error: "Paste some rows or choose a .csv, .xlsx or .xls file first." };
}

function readMapping(formData: FormData, headerCount: number): Record<number, string> | null {
  const raw = formData.get("mapping");
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const i = Number(k);
      if (Number.isInteger(i) && i >= 0 && i < headerCount && typeof v === "string" && v) out[i] = v;
    }
    return out;
  } catch {
    return null;
  }
}

function columnMeta(entity: EntityType): ColumnMeta[] {
  return IMPORTERS[entity].columns.map((c) => ({
    key: c.key,
    label: c.label,
    required: Boolean(c.required),
    note: c.note,
  }));
}

// Locate the header row (scanning the first 10 rows) and split the matrix into
// header + data. Returns a 0-based header index, a 1-based headerRow for display,
// and the data rows below it. `error` is set (and the rest empty) when no header
// row can be found — refused loudly, once.
function splitAtHeader(
  entity: EntityType,
  records: string[][]
): { error?: string; headerIndex: number; headerRow: number; headers: string[]; data: string[][] } {
  const def = IMPORTERS[entity];
  const headerIndex = detectHeaderRow(def, records);
  if (headerIndex < 0) {
    return {
      error:
        "Couldn't find a header row in the first 10 rows. The file needs a row whose cells name the columns (e.g. sku, product name, brand) above the data. Add or fix the header and re-upload.",
      headerIndex: -1,
      headerRow: 0,
      headers: [],
      data: [],
    };
  }
  return {
    headerIndex,
    headerRow: headerIndex + 1,
    headers: records[headerIndex],
    data: records.slice(headerIndex + 1),
  };
}

// The exact loud message for a missing required column: name the field(s), state
// where the header was detected, and list the columns the file actually has so
// the operator can rename one. One message — never one error per row.
function missingColumnMessage(
  entity: EntityType,
  mapping: Record<number, string>,
  headers: string[],
  headerRow: number
): string | null {
  const missing = missingRequiredColumns(IMPORTERS[entity], mapping);
  if (missing.length === 0) return null;
  const fields = missing.map((m) => `\`${m.key}\``).join(", ");
  const found = headers.map((h) => (h || "").trim()).filter(Boolean).join(", ") || "(none)";
  const plural = missing.length > 1;
  return (
    `Could not find a column for ${fields}. Header detected on row ${headerRow}. ` +
    `Columns found: ${found}. Rename ${plural ? "columns" : "one"} to ${fields} ` +
    `(or a recognised alias) and re-upload — nothing was imported.`
  );
}

export async function previewImport(_prev: PreviewState, formData: FormData): Promise<PreviewState> {
  const profile = await requireProfile();
  const entity = parseEntity(formData.get("entity"));
  if (!entity) return { ok: false, error: "Choose what you're importing." };
  if (!canImport(entity, profile)) {
    return { ok: false, error: `You don't have access to import ${IMPORTERS[entity].label}.` };
  }

  const read = await readTabular(formData);
  if (!read.ok) return { ok: false, error: read.error };
  const records = read.records;
  const { fileName, fileSize } = read;
  if (records.length < 2) {
    return { ok: false, error: "The file needs a header row and at least one data row." };
  }

  // Header isn't assumed to be row 1 — scan the first 10 rows for it.
  const split = splitAtHeader(entity, records);
  if (split.error) return { ok: false, error: split.error };
  const { headerRow, headers } = split;
  const allData = split.data;
  let data = allData;
  const droppedRows = Math.max(0, data.length - MAX_ROWS);
  if (droppedRows > 0) data = data.slice(0, MAX_ROWS);

  const def = IMPORTERS[entity];
  const mapping = readMapping(formData, headers.length) ?? autoMap(def, headers);

  // Refuse the WHOLE file when a required column is missing / unmappable — name
  // them, say where the header was found, list the columns present. One message.
  const missMsg = missingColumnMessage(entity, mapping, headers, headerRow);
  if (missMsg) return { ok: false, error: missMsg, headerRow };

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;
  const ctx = await loadContext(db, entity, profile.org_id);

  // Products: resolve the brand column to a single client BEFORE classifying, so a
  // 0/>1 brand match refuses the whole file rather than importing brand_id NULL.
  let resolvedBrands: Array<{ value: string; brand: string }> | undefined;
  if (entity === "products") {
    const br = resolveProductBrands(data, mapping, ctx.brands);
    if (!br.ok) return { ok: false, error: br.error, headerRow };
    ctx.productBrandByValue = br.byValue;
    resolvedBrands = br.resolved;
  }

  const classified = classify(def, data, mapping, ctx, headerRow + 1);
  const preview = buildPreview(def, classified, mapping);

  // What lands where, plus the columns we're deliberately ignoring, for the
  // confirm step (requirement: show resolved mapping + "ignored: …").
  const mappedIdx = new Set(Object.keys(mapping).map(Number));
  const ignoredColumns = headers
    .map((h, i) => ({ h: (h || "").trim(), i }))
    .filter((c) => c.h && !mappedIdx.has(c.i))
    .map((c) => c.h);

  return {
    ok: true,
    entity,
    fileName,
    fileSize,
    headerRow,
    // Echo the parsed matrix as canonical CSV (header first) so the confirm /
    // re-preview steps re-submit identical bytes regardless of the original format
    // (CSV, XLSX, XLS) or where the header sat in the upload.
    csv: toCsv(headers, allData),
    headers,
    columns: columnMeta(entity),
    mapping,
    ignoredColumns,
    resolvedBrands,
    preview,
    droppedRows,
  };
}

export async function commitImport(_prev: CommitState, formData: FormData): Promise<CommitState> {
  const profile = await requireProfile();
  const entity = parseEntity(formData.get("entity"));
  if (!entity) return { ok: false, error: "Choose what you're importing." };
  if (!canImport(entity, profile)) {
    return { ok: false, error: `You don't have access to import ${IMPORTERS[entity].label}.` };
  }

  const read = await readTabular(formData);
  if (!read.ok) return { ok: false, error: read.error };
  const records = read.records;
  const { fileName, fileSize } = read;
  if (records.length < 2) return { ok: false, error: "The file needs a header row and at least one data row." };

  const split = splitAtHeader(entity, records);
  if (split.error) return { ok: false, error: split.error };
  const { headerRow, headers } = split;
  let data = split.data;
  const droppedRows = Math.max(0, data.length - MAX_ROWS);
  if (droppedRows > 0) data = data.slice(0, MAX_ROWS);

  const def = IMPORTERS[entity];
  const mapping = readMapping(formData, headers.length) ?? autoMap(def, headers);

  // Same whole-file refusal as preview: a missing required column writes nothing.
  const missMsg = missingColumnMessage(entity, mapping, headers, headerRow);
  if (missMsg) return { ok: false, error: missMsg };

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Re-classify against the live DB so nothing committed between preview and now
  // slips through (or gets double-inserted).
  const ctx = await loadContext(db, entity, profile.org_id);

  // Products: resolve brand strictly before committing — never write brand_id NULL.
  if (entity === "products") {
    const br = resolveProductBrands(data, mapping, ctx.brands);
    if (!br.ok) return { ok: false, error: br.error };
    ctx.productBrandByValue = br.byValue;
  }

  const classified = classify(def, data, mapping, ctx, headerRow + 1);

  const valid = classified.filter((r) => r.status === "valid");
  const duplicates = classified.filter((r) => r.status === "duplicate").length;
  const invalid = classified.filter((r) => r.status === "error").length;
  const report = reportRows(classified);

  let imported = 0;
  let warning: string | undefined;
  try {
    const res = await commitRows(db, entity, valid, { orgId: profile.org_id, userId: profile.id });
    imported = res.imported;
    warning = res.warning;
  } catch (e) {
    // Nothing was written (the insert is one atomic statement) — report honestly
    // and do NOT record a success audit row.
    const msg = e instanceof Error ? e.message : "Import failed.";
    return { ok: false, error: msg, entity, total: classified.length, duplicates, invalid, report };
  }

  // Audit: one immutable import_batches row, always — even when 0 rows imported.
  const noteParts: string[] = [];
  if (warning) noteParts.push(warning);
  if (droppedRows > 0) noteParts.push(`${droppedRows} row(s) beyond the ${MAX_ROWS}-row limit were not processed`);
  const { error: auditErr } = await db.from("import_batches").insert({
    org_id: profile.org_id,
    imported_by: profile.id,
    entity_type: entity,
    file_name: fileName ?? null,
    file_size_bytes: fileSize ?? null,
    total_rows: classified.length,
    valid_rows: valid.length,
    imported_rows: imported,
    duplicate_rows: duplicates,
    invalid_rows: invalid,
    error_report: report,
    notes: noteParts.join(" · ") || null,
  });

  // Revalidate the domains an import can change so their pages reflect it.
  revalidatePath("/imports");
  if (entity === "products") revalidatePath("/warehouse");
  if (entity === "creators" || entity === "affiliate_performance") revalidatePath("/creators");
  if (entity === "metric_entries" || entity === "metrics_snapshots") revalidatePath("/metrics");

  const messages = [`${imported} of ${classified.length} row(s) imported`];
  if (duplicates) messages.push(`${duplicates} duplicate(s) blocked`);
  if (invalid) messages.push(`${invalid} invalid row(s) reported`);
  if (warning) messages.push(warning);
  if (droppedRows > 0) messages.push(`${droppedRows} row(s) beyond the ${MAX_ROWS}-row cap skipped`);
  if (auditErr) messages.push("(audit row could not be written)");

  // A bounded inline list of what didn't import — 10 lines + "…and N more" — so a
  // messy file doesn't dump one line per row (the full set is in the report CSV).
  const errorLines = capLines(report.map((r) => `Line ${r.line}: ${r.label} — ${r.reason}`));

  return {
    ok: true,
    entity,
    imported,
    duplicates,
    invalid,
    total: classified.length,
    droppedRows,
    message: messages.join(" · "),
    errorLines,
    report,
  };
}
