// lib/import/engine.ts — the DB-facing half of the Bulk Import tool, kept out of
// the server-action file so the classification/commit logic is one implementation
// shared by preview and commit. It takes a minimal Supabase "shim" (the same
// { from } cast the rest of the OS uses for tables absent from the generated
// types) so it never imports React or Next and stays straightforward to reason
// about. Real access control is the per-type gate below PLUS table RLS; this
// module assumes the caller has already checked canImport().

import { normalizeHeader } from "./csv";
import {
  IMPORTERS,
  dedupKeys,
  describeRow,
  normalizeRecord,
  type EntityType,
  type ImporterDef,
  type NormRecord,
  type Resolved,
} from "./registry";

export type Shim = { from: (t: string) => any };

export type RowStatus = "valid" | "duplicate" | "error";

// The full server-side classification of one data row.
export interface ClassifiedRow {
  line: number; // source line number (1 = header, so data starts at 2)
  label: string;
  status: RowStatus;
  messages: string[];
  values: NormRecord;
  resolved: Resolved;
}

// The client-safe projection sent to the browser.
export interface PreviewRowView {
  line: number;
  label: string;
  status: RowStatus;
  messages: string[];
}

// One destination field of one sampled row: the canonical column, its label, and
// the normalized value ("—" for an honest blank) that WOULD be written.
export interface MappedField {
  key: string;
  label: string;
  value: string;
}

// The first few data rows projected onto their destination fields, so the operator
// confirms the mapping is right BEFORE anything is written.
export interface MappedSampleRow {
  line: number;
  status: RowStatus;
  fields: MappedField[];
}

export interface PreviewResult {
  totals: { total: number; valid: number; duplicates: number; invalid: number };
  rows: PreviewRowView[];
  sampleTruncated: boolean;
  // The first 5 rows mapped to their destination fields (requirement: preview shows
  // exactly what lands where before commit).
  mappedSample: MappedSampleRow[];
}

// ── Access control (pure) ───────────────────────────────────────────────────

export interface Who {
  role: string;
  team_assignment?: string | null;
}

function isLeadership(who: Who): boolean {
  return who.role === "ceo" || who.role === "coo" || who.role === "department_head";
}

// Who may run a given importer. Mirrors the target tables' RLS write predicates:
//   products     → leadership OR a Warehouse team member (products/stock RLS, 0026)
//   creators     → leadership OR Business Development / Affiliate (owning teams)
//   metric_*     → leadership only (metric_entries / metrics_snapshots RLS)
export function canImport(entity: EntityType, who: Who): boolean {
  const team = (who.team_assignment ?? "").trim().toLowerCase();
  switch (entity) {
    case "products":
      return isLeadership(who) || team.includes("warehouse");
    case "creators":
    case "affiliate_performance":
      // Same owning teams as the creators importer: the affiliate export writes to
      // creators (attributed GMV) + creator_posts, both BD / Affiliate territory.
      return isLeadership(who) || team === "business development" || team === "affiliate marketing";
    case "metric_entries":
    case "metrics_snapshots":
      return isLeadership(who);
  }
}

export function allowedEntities(who: Who): EntityType[] {
  return (Object.keys(IMPORTERS) as EntityType[]).filter((e) => canImport(e, who));
}

// ── Context: brand/department name→id maps + the set of existing dedup keys ───

export interface ImportContext {
  brandIdByName: Map<string, string>;
  departmentIdByName: Map<string, string>;
  // Affiliate import only: existing creators keyed `${platform}:${handle}` (both
  // lower-cased), matching creators_org_handle_uniq. Used to resolve a handle to an
  // existing creator_id — the affiliate importer never creates creators.
  creatorIdByHandle: Map<string, string>;
  existingKeys: Set<string>;
  // Products only: the org's brands, and the resolved brand_id for each distinct
  // brand cell value (built by resolveProductBrands and set before classify). A
  // products row's brand_id comes from here — guaranteed non-null because the
  // whole file is refused if any value fails to resolve.
  brands: BrandRow[];
  productBrandByValue: Map<string, string>;
}

const lc = (s: string) => s.trim().toLowerCase();

// The handle key the affiliate importer resolves on. Platform defaults to tiktok
// (as it does on the creators table). A leading "@" is stripped on BOTH sides —
// rosters store handles inconsistently ("@name" vs "name") and Seller Center exports
// usernames without the "@", so folding it makes the match forgiving. Applied
// identically when building the map and when looking a row up, so the two stay in
// step.
export function handleKey(platform: string | null | undefined, handle: string): string {
  const p = (platform ?? "").trim().toLowerCase() || "tiktok";
  const h = handle.trim().toLowerCase().replace(/^@+/, "");
  return `${p}:${h}`;
}

export async function loadContext(db: Shim, entity: EntityType, orgId: string): Promise<ImportContext> {
  const brandIdByName = new Map<string, string>();
  const departmentIdByName = new Map<string, string>();
  const creatorIdByHandle = new Map<string, string>();
  const existingKeys = new Set<string>();
  const brands: BrandRow[] = [];

  const usesBrand = entity !== "creators" && entity !== "affiliate_performance";
  if (usesBrand) {
    const { data } = await db.from("brands").select("id, name").eq("org_id", orgId);
    for (const b of (data ?? []) as Array<{ id: string; name: string | null }>) {
      if (b.name) {
        brandIdByName.set(lc(b.name), b.id);
        brands.push({ id: b.id, name: b.name });
      }
    }
  }
  if (entity === "metrics_snapshots") {
    const { data } = await db.from("departments").select("id, name").eq("org_id", orgId);
    for (const d of (data ?? []) as Array<{ id: string; name: string | null }>) {
      if (d.name) departmentIdByName.set(lc(d.name), d.id);
    }
  }

  // Existing dedup keys, built the same way dedupKeys() builds them for a row.
  switch (entity) {
    case "products": {
      const { data } = await db.from("products").select("brand_id, sku").eq("org_id", orgId);
      for (const p of (data ?? []) as Array<{ brand_id: string | null; sku: string | null }>) {
        const sku = (p.sku ?? "").trim().toLowerCase();
        if (sku) existingKeys.add(`p:${p.brand_id ?? ""}:${sku}`);
      }
      break;
    }
    case "creators": {
      const { data } = await db.from("creators").select("email, phone, handle, platform").eq("org_id", orgId);
      for (const c of (data ?? []) as Array<{ email: string | null; phone: string | null; handle: string | null; platform: string | null }>) {
        const email = (c.email ?? "").trim().toLowerCase();
        if (email) existingKeys.add(`e:${email}`);
        const phone = (c.phone ?? "").trim();
        if (phone) existingKeys.add(`ph:${phone}`);
        const handle = (c.handle ?? "").trim().toLowerCase();
        if (handle) existingKeys.add(`h:${(c.platform ?? "tiktok").trim().toLowerCase() || "tiktok"}:${handle}`);
      }
      break;
    }
    case "metric_entries": {
      const { data } = await db.from("metric_entries").select("metric_key, brand_id, period_start, period_end").eq("org_id", orgId);
      for (const m of (data ?? []) as Array<{ metric_key: string; brand_id: string | null; period_start: string; period_end: string }>) {
        existingKeys.add(`m:${lc(m.metric_key)}:${m.brand_id ?? "org"}:${m.period_start}:${m.period_end}`);
      }
      break;
    }
    case "metrics_snapshots": {
      const { data } = await db.from("metrics_snapshots").select("department_id, brand_id, period_start, period_end").eq("org_id", orgId);
      for (const s of (data ?? []) as Array<{ department_id: string | null; brand_id: string | null; period_start: string; period_end: string }>) {
        existingKeys.add(`s:${s.department_id ?? ""}:${s.brand_id ?? ""}:${s.period_start}:${s.period_end}`);
      }
      break;
    }
    case "affiliate_performance": {
      // Resolve handles to existing creators. existingKeys is intentionally left
      // EMPTY: the commit UPSERTS posts, so a post already in the DB must classify as
      // "valid" and refresh in place — not be blocked as a duplicate. Within-file
      // duplicate post_urls are still caught by the classifier's own seen-set.
      const { data } = await db.from("creators").select("id, handle, platform").eq("org_id", orgId);
      for (const c of (data ?? []) as Array<{ id: string; handle: string | null; platform: string | null }>) {
        const handle = (c.handle ?? "").trim();
        if (handle) creatorIdByHandle.set(handleKey(c.platform, handle), c.id);
      }
      break;
    }
  }

  return { brandIdByName, departmentIdByName, creatorIdByHandle, existingKeys, brands, productBrandByValue: new Map() };
}

// ── Classification ──────────────────────────────────────────────────────────

// Cap the number of data rows processed in one import so a pathological file
// can't run unbounded. Anything beyond this is reported, never silently dropped.
export const MAX_ROWS = 5000;

// ── Header detection ──────────────────────────────────────────────────────────

// The whole normalised header vocabulary a def recognises (key + label + every
// alias). Built once so both header detection and mapping agree on "is this a
// known column name".
function knownHeaderKeys(def: ImporterDef): Set<string> {
  const known = new Set<string>();
  for (const col of def.columns) {
    known.add(normalizeHeader(col.key));
    known.add(normalizeHeader(col.label));
    for (const a of col.aliases ?? []) known.add(normalizeHeader(a));
  }
  known.delete(""); // never let a blank normalise-to-nothing count as a match
  return known;
}

// Find the header row. Real files don't always put it on row 1 — a Seller Center
// export (LIAO's) carries two title rows above the real header on row 3. Scan the
// first `scan` rows and return the index of the FIRST row that has >=2 non-empty
// cells AND >=1 cell matching a known column name/alias. Returns -1 when no such
// row exists in the scanned window (the caller refuses the file, loudly, once).
export function detectHeaderRow(def: ImporterDef, records: string[][], scan = 10): number {
  const known = knownHeaderKeys(def);
  const limit = Math.min(scan, records.length);
  for (let i = 0; i < limit; i++) {
    const row = records[i] ?? [];
    const nonEmpty = row.reduce((n, c) => (String(c ?? "").trim() !== "" ? n + 1 : n), 0);
    if (nonEmpty < 2) continue;
    const hasKnown = row.some((c) => known.has(normalizeHeader(String(c ?? ""))));
    if (hasKnown) return i;
  }
  return -1;
}

// ── Brand resolution (products) ───────────────────────────────────────────────

export interface BrandRow {
  id: string;
  name: string;
}

// The outcome of resolving every distinct brand value in a products file. On
// success, `byValue` maps each lower/trimmed brand cell to its brand_id and
// `resolved` is the source→brand pairs shown in the preview. On failure, `error`
// is ONE ready-to-show message naming the unresolved value and its candidates.
export interface BrandResolution {
  ok: boolean;
  byValue: Map<string, string>;
  resolved: Array<{ value: string; brand: string }>;
  error?: string;
}

// Match a single brand cell against the org's brands: exact (case/space-folded)
// name wins; otherwise a prefix match in EITHER direction (a file's "LIAO"
// resolves "Liao Philippines"; a file's "Liao Philippines Inc" resolves "Liao
// Philippines"). Returns the unique match, or all candidates when 0 / >1.
function matchBrand(value: string, brands: BrandRow[]): { id?: string; candidates: BrandRow[] } {
  const v = value.trim().toLowerCase();
  const exact = brands.filter((b) => b.name.trim().toLowerCase() === v);
  if (exact.length === 1) return { id: exact[0].id, candidates: exact };
  if (exact.length > 1) return { candidates: exact };
  const prefix = brands.filter((b) => {
    const n = b.name.trim().toLowerCase();
    return n.startsWith(v) || v.startsWith(n);
  });
  if (prefix.length === 1) return { id: prefix[0].id, candidates: prefix };
  return { candidates: prefix };
}

// Resolve the brand column for a products import BEFORE any row is classified, so
// a bad brand fails the whole file loudly and ONCE rather than silently importing
// 104 rows with brand_id NULL. Every distinct non-empty brand value must resolve
// to exactly one brand; a 0-or->1 match aborts with the candidates listed. Blank
// brand cells are left to the per-row required check (brand is a required column).
export function resolveProductBrands(
  data: string[][],
  mapping: Record<number, string>,
  brands: BrandRow[]
): BrandResolution {
  const brandIdx = Object.entries(mapping).find(([, key]) => key === "brand")?.[0];
  const byValue = new Map<string, string>();
  const resolved: Array<{ value: string; brand: string }> = [];
  // No brand column mapped at all → the missing-required-column gate handles it
  // upstream; nothing to resolve here.
  if (brandIdx == null) return { ok: true, byValue, resolved };

  const col = Number(brandIdx);
  const seen = new Set<string>();
  const byId = new Map(brands.map((b) => [b.id, b.name]));
  for (const record of data) {
    const rawVal = String(record[col] ?? "").trim();
    if (!rawVal) continue; // blank → per-row "Brand is required"
    const key = rawVal.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const { id, candidates } = matchBrand(rawVal, brands);
    if (!id) {
      const list =
        candidates.length === 0
          ? "no client matches"
          : `matches ${candidates.length} clients: ${candidates.map((c) => c.name).join(", ")}`;
      return {
        ok: false,
        byValue,
        resolved,
        error: `Brand "${rawVal}" ${list}. Add the client (or rename the column value to match exactly one existing client), then re-upload — nothing was imported.`,
      };
    }
    byValue.set(key, id);
    resolved.push({ value: rawVal, brand: byId.get(id) ?? rawVal });
  }
  return { ok: true, byValue, resolved };
}

function buildRaw(record: string[], mapping: Record<number, string>): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [idxStr, key] of Object.entries(mapping)) {
    if (!key) continue;
    raw[key] = record[Number(idxStr)] ?? "";
  }
  return raw;
}

// Classify every data row into valid / duplicate / error, resolving brand and
// department names and detecting duplicates against both the DB and earlier rows
// in the same file (a file that repeats a key internally blocks the later copy).
// `firstDataLine` is the source line number of the FIRST data row (1-based), so
// error/preview line numbers point at the real row in the uploaded file even when
// the header wasn't on row 1. Defaults to 2 (header on row 1, data from row 2).
export function classify(
  def: ImporterDef,
  dataRecords: string[][],
  mapping: Record<number, string>,
  ctx: ImportContext,
  firstDataLine = 2
): ClassifiedRow[] {
  const out: ClassifiedRow[] = [];
  const seen = new Set<string>();

  dataRecords.forEach((record, i) => {
    const line = firstDataLine + i;
    const raw = buildRaw(record, mapping);
    const { values, errors } = normalizeRecord(def, raw);

    // Resolve brand / department names to ids (unknown name → null, noted).
    const resolved: Resolved = {};
    const notes: string[] = [];
    const resolveErrors: string[] = [];
    // Affiliate import: match the handle to an EXISTING creator. An unknown handle
    // is a hard ERROR — we never fabricate a creator from an analytics export, and a
    // post with no creator can't be written.
    if ("creator_handle" in values) {
      const handle = typeof values.creator_handle === "string" ? values.creator_handle : "";
      const platform = typeof values.platform === "string" ? values.platform : "";
      if (handle) {
        const id = ctx.creatorIdByHandle.get(handleKey(platform, handle)) ?? null;
        resolved.creatorId = id;
        if (!id) resolveErrors.push(`creator "${handle}" not found — add them in Creators first`);
      } else {
        resolved.creatorId = null;
      }
    }
    if ("brand" in values) {
      const name = values.brand;
      if (def.entity === "products") {
        // Products key on the pre-resolved map from resolveProductBrands(). A
        // non-blank value is guaranteed present (the file was refused otherwise);
        // a blank value already produced the required-field error above, so this
        // row won't reach the insert.
        const id = typeof name === "string" && name ? ctx.productBrandByValue.get(lc(name)) ?? null : null;
        resolved.brandId = id;
      } else if (typeof name === "string" && name) {
        const id = ctx.brandIdByName.get(lc(name)) ?? null;
        resolved.brandId = id;
        if (!id) notes.push(`brand "${name}" not found — imported with no brand`);
      } else {
        resolved.brandId = null;
      }
    }
    if ("department" in values) {
      const name = values.department;
      if (typeof name === "string" && name) {
        const id = ctx.departmentIdByName.get(lc(name)) ?? null;
        resolved.departmentId = id;
        if (!id) notes.push(`department "${name}" not found — imported org-level`);
      } else {
        resolved.departmentId = null;
      }
    }

    const allErrors = errors.concat(resolveErrors);
    if (allErrors.length > 0) {
      out.push({ line, label: describeRow(def.entity, values), status: "error", messages: allErrors, values, resolved });
      return;
    }

    const keys = dedupKeys(def.entity, values, resolved);
    const hit = keys.find((k) => ctx.existingKeys.has(k) || seen.has(k));
    if (hit) {
      const where = ctx.existingKeys.has(hit) ? "already exists" : "duplicated earlier in this file";
      out.push({
        line,
        label: describeRow(def.entity, values),
        status: "duplicate",
        messages: [`${def.dedupLabel} ${where}`],
        values,
        resolved,
      });
      return;
    }

    for (const k of keys) seen.add(k);
    out.push({ line, label: describeRow(def.entity, values), status: "valid", messages: notes, values, resolved });
  });

  return out;
}

// Render one normalized value for the mapped-sample preview. A blank is "—" (an
// honest unknown), never 0; a boolean reads yes/no.
function fmtValue(v: NormRecord[string]): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export function buildPreview(
  def: ImporterDef,
  classified: ClassifiedRow[],
  mapping: Record<number, string>,
  sampleLimit = 300,
  mappedLimit = 5
): PreviewResult {
  const totals = { total: classified.length, valid: 0, duplicates: 0, invalid: 0 };
  for (const r of classified) {
    if (r.status === "valid") totals.valid++;
    else if (r.status === "duplicate") totals.duplicates++;
    else totals.invalid++;
  }
  const rows = classified
    .slice(0, sampleLimit)
    .map(({ line, label, status, messages }) => ({ line, label, status, messages }));

  // Project the first `mappedLimit` rows onto only the destination fields actually
  // mapped, in the def's column order — the "first 5 rows mapped to destination
  // fields" the operator confirms before commit.
  const mappedKeys = new Set(Object.values(mapping).filter(Boolean));
  const usedCols = def.columns.filter((c) => mappedKeys.has(c.key));
  const mappedSample: MappedSampleRow[] = classified.slice(0, mappedLimit).map((r) => ({
    line: r.line,
    status: r.status,
    fields: usedCols.map((c) => ({ key: c.key, label: c.label, value: fmtValue(r.values[c.key]) })),
  }));

  return { totals, rows, sampleTruncated: classified.length > sampleLimit, mappedSample };
}

// The required columns a mapping does NOT satisfy. Used to refuse a whole file up
// front (naming them) rather than importing part of it — a missing required COLUMN
// is a file-shape problem, distinct from a blank required CELL in one row.
export function missingRequiredColumns(
  def: ImporterDef,
  mapping: Record<number, string>
): Array<{ key: string; label: string }> {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  return def.columns.filter((c) => c.required && !mapped.has(c.key)).map((c) => ({ key: c.key, label: c.label }));
}

// Cap a list of human-readable lines at `max`, appending "…and N more" so a
// pathological file surfaces one bounded message, never one line per row.
export function capLines(lines: string[], max = 10): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `…and ${lines.length - max} more`];
}

// The invalid + duplicate rows, for the downloadable error report. Valid rows
// are excluded — the report is exactly "what did NOT import and why".
export function reportRows(classified: ClassifiedRow[]): Array<{ line: number; status: string; label: string; reason: string }> {
  return classified
    .filter((r) => r.status !== "valid")
    .map((r) => ({ line: r.line, status: r.status, label: r.label, reason: r.messages.join("; ") }));
}

// ── Commit ──────────────────────────────────────────────────────────────────

// Only non-null values become insert columns, so a blank cell yields SQL NULL
// (nullable columns) or the table default (NOT-NULL-with-default columns) —
// never a fabricated 0 or "".
function pick(values: NormRecord, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (values[k] != null) out[k] = values[k];
  return out;
}

export interface CommitResult {
  imported: number;
  warning?: string;
}

const PRODUCT_MAIN = [
  "sku", "product_name", "category", "variant", "barcode", "warehouse_location",
  "unit_value", "cost", "selling_price", "reorder_point", "target_cover_days",
  "status", "is_fragile", "is_perishable", "is_high_value", "stocked_at", "expiry_date", "notes",
];
const PRODUCT_STOCK = ["current_stock", "reserved_stock", "damaged_stock", "in_transit", "reorder_level"];
const CREATOR_COLS = [
  "name", "platform", "handle", "category", "follower_count", "email", "phone",
  "viber", "tier", "status", "attributed_gmv", "posts_committed", "notes",
];

// Insert the valid rows for one entity. Returns how many rows were actually
// written. Throws on a DB error so the caller can report it honestly rather than
// claim a success it didn't get.
export async function commitRows(
  db: Shim,
  entity: EntityType,
  valid: ClassifiedRow[],
  who: { orgId: string; userId: string }
): Promise<CommitResult> {
  if (valid.length === 0) return { imported: 0 };

  switch (entity) {
    case "products": {
      const productRows = valid.map((r) => ({
        org_id: who.orgId,
        created_by: who.userId,
        brand_id: r.resolved.brandId ?? null,
        ...pick(r.values, PRODUCT_MAIN),
      }));
      const { data, error } = await db.from("products").insert(productRows).select("id, sku, brand_id");
      if (error) throw new Error(`products insert failed: ${error.message}`);
      const inserted = (data ?? []) as Array<{ id: string; sku: string; brand_id: string | null }>;

      // Map (brand_id, sku) → new id so stock rows attach regardless of return order.
      const idByKey = new Map<string, string>();
      for (const p of inserted) idByKey.set(`${p.brand_id ?? ""}:${(p.sku ?? "").trim().toLowerCase()}`, p.id);

      const stockRows: Record<string, unknown>[] = [];
      for (const r of valid) {
        const stock = pick(r.values, PRODUCT_STOCK);
        if (Object.keys(stock).length === 0) continue; // no opening count → no stock_levels row
        const key = `${r.resolved.brandId ?? ""}:${String(r.values.sku ?? "").trim().toLowerCase()}`;
        const pid = idByKey.get(key);
        if (!pid) continue;
        stockRows.push({ org_id: who.orgId, product_id: pid, brand_id: r.resolved.brandId ?? null, ...stock });
      }
      let warning: string | undefined;
      if (stockRows.length > 0) {
        const { error: stockErr } = await db.from("stock_levels").insert(stockRows);
        if (stockErr) warning = `${inserted.length} products imported, but opening stock failed: ${stockErr.message}`;
      }
      return { imported: inserted.length, warning };
    }

    case "creators": {
      const rows = valid.map((r) => ({
        org_id: who.orgId,
        created_by: who.userId,
        ...pick(r.values, CREATOR_COLS),
      }));
      const { error } = await db.from("creators").insert(rows);
      if (error) throw new Error(`creators insert failed: ${error.message}`);
      return { imported: rows.length };
    }

    case "metric_entries": {
      const rows = valid.map((r) => ({
        org_id: who.orgId,
        metric_key: String(r.values.metric_key),
        brand_id: r.resolved.brandId ?? null,
        period_start: r.values.period_start,
        period_end: r.values.period_end,
        manual_value: r.values.manual_value,
        origin: "manual",
        entered_by: who.userId,
      }));
      const { error } = await db.from("metric_entries").insert(rows);
      if (error) throw new Error(`metric_entries insert failed: ${error.message}`);
      return { imported: rows.length };
    }

    case "metrics_snapshots": {
      const rows = valid.map((r) => ({
        org_id: who.orgId,
        created_by: who.userId,
        department_id: r.resolved.departmentId ?? null,
        brand_id: r.resolved.brandId ?? null,
        period_start: r.values.period_start,
        period_end: r.values.period_end,
        ...pick(r.values, ["gmv_impact", "efficiency", "quality_score", "capacity_utilization"]),
      }));
      const { error } = await db.from("metrics_snapshots").insert(rows);
      if (error) throw new Error(`metrics_snapshots insert failed: ${error.message}`);
      return { imported: rows.length };
    }

    case "affiliate_performance": {
      // A row without a valid file date keeps posted_at at import time; a dated row
      // sets it to that date, so a re-import of a dated export is fully idempotent.
      const nowIso = new Date().toISOString();
      const postRows = valid.map((r) => ({
        org_id: who.orgId,
        created_by: who.userId,
        creator_id: r.resolved.creatorId as string, // non-null for a valid row
        post_url: String(r.values.post_url),
        platform: typeof r.values.platform === "string" && r.values.platform ? r.values.platform : null,
        posted_at: typeof r.values.posted_at === "string" && r.values.posted_at ? r.values.posted_at : nowIso,
        status: "posted",
        // Honest nulls: an unreported figure stays null (renders "—"), never 0.
        gmv: r.values.gmv ?? null,
        orders: r.values.orders ?? null,
        commission: r.values.commission ?? null,
        currency: "PHP",
      }));

      // UPSERT on the natural key so a re-imported export refreshes posts in place.
      const { error } = await db
        .from("creator_posts")
        .upsert(postRows, { onConflict: "org_id,creator_id,post_url" });
      if (error) throw new Error(`affiliate posts upsert failed: ${error.message}`);

      // Roll each touched creator's attributed_gmv up from the SUM of ALL their
      // posts' attributed GMV — honest null when NONE reported a figure (never 0),
      // idempotent on re-import, and correctly cumulative across separate exports.
      const creatorIds = Array.from(new Set(postRows.map((p) => p.creator_id)));
      let warning: string | undefined;
      if (creatorIds.length > 0) {
        const { data: postGmv, error: readErr } = await db
          .from("creator_posts")
          .select("creator_id, gmv")
          .eq("org_id", who.orgId)
          .in("creator_id", creatorIds);
        if (readErr) {
          warning = `${postRows.length} post(s) imported, but the attributed-GMV rollup could not be read: ${readErr.message}`;
        } else {
          const sumByCreator = new Map<string, number>();
          const hasGmv = new Set<string>();
          for (const p of (postGmv ?? []) as Array<{ creator_id: string; gmv: number | null }>) {
            if (p.gmv == null) continue;
            hasGmv.add(p.creator_id);
            sumByCreator.set(p.creator_id, (sumByCreator.get(p.creator_id) ?? 0) + Number(p.gmv));
          }
          let failed = 0;
          for (const cid of creatorIds) {
            const attributed = hasGmv.has(cid) ? sumByCreator.get(cid) ?? 0 : null;
            const { error: upErr } = await db
              .from("creators")
              .update({ attributed_gmv: attributed })
              .eq("id", cid)
              .eq("org_id", who.orgId);
            if (upErr) failed++;
          }
          if (failed > 0) warning = `${postRows.length} post(s) imported, but ${failed} creator GMV rollup(s) failed`;
        }
      }
      return { imported: postRows.length, warning };
    }
  }
}
