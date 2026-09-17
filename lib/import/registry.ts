// lib/import/registry.ts — the importer catalogue and the pure row engine for
// the CSV Bulk Import tool. Each entity (products, creators, historical metrics)
// declares its columns, aliases and validation here, and one shared
// validate/normalise routine turns a raw mapped row into a typed record + a list
// of human-readable errors. No DB, no React — this module is pure so the same
// rules run in the preview and the commit, and can be unit-tested in isolation.
//
// Honest nulls: an empty cell normalises to null. The commit builds its insert
// from the non-null values only, so a nullable column becomes SQL NULL and a
// NOT-NULL-with-default column (status, platform, the product flags) falls back
// to its database default — a blank is never silently written as 0 or "".

import { normalizeHeader } from "./csv";

export type EntityType =
  | "products"
  | "creators"
  | "metric_entries"
  | "metrics_snapshots"
  | "affiliate_performance";

export type FieldType =
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "enum"
  | "brand" // free-text brand NAME; resolved to brand_id at commit
  | "department"; // free-text department NAME; resolved to department_id at commit

export interface ColumnSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  aliases?: string[]; // extra header spellings (normalised) that auto-map here
  enumValues?: string[];
  note?: string;
}

export type NormValue = string | number | boolean | null;
export type NormRecord = Record<string, NormValue>;

// Ids resolved from name columns by the commit step, threaded into dedup-key and
// insert building so those stay pure of DB access.
export interface Resolved {
  brandId?: string | null;
  departmentId?: string | null;
  // The affiliate importer matches an EXISTING creator by handle; resolved here so
  // the pure engine keys dedup and builds the upsert on the same creator_id the
  // creator_posts table uses. `null` means "handle carried no match" — an error.
  creatorId?: string | null;
}

export interface ImporterDef {
  entity: EntityType;
  label: string;
  description: string;
  // Which team owns this importer, shown in the UI. Real enforcement is the
  // per-type permission check in the server action + table RLS.
  ownerHint: string;
  columns: ColumnSpec[];
  // The natural-key description shown in the preview ("SKU within brand", etc.).
  dedupLabel: string;
  // Cross-field checks that a single-field normaliser can't express.
  validateRecord?: (values: NormRecord) => string[];
}

// ── Field-level normalisation ───────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function cleanNumber(raw: string): number {
  // Tolerate thousands separators, surrounding whitespace and a currency symbol
  // (₱ / $ / PHP) so "₱1,299.00" imports as 1299.
  const cleaned = raw.replace(/php/gi, "").replace(/[₱$,\s]/g, "");
  return Number(cleaned);
}

const TRUE_SET = new Set(["true", "yes", "y", "1", "t"]);
const FALSE_SET = new Set(["false", "no", "n", "0", "f"]);

// Normalise one raw cell against its spec. Returns the typed value (or null for
// an honest blank) plus an optional error message. A required blank, an
// unparseable number/date, or an out-of-vocabulary enum is an error.
export function normalizeField(
  spec: ColumnSpec,
  raw: string | undefined
): { value: NormValue; error?: string } {
  const trimmed = (raw ?? "").trim();

  if (trimmed === "") {
    if (spec.required) return { value: null, error: `${spec.label} is required` };
    return { value: null };
  }

  switch (spec.type) {
    case "number": {
      const n = cleanNumber(trimmed);
      if (!Number.isFinite(n)) return { value: null, error: `${spec.label} "${raw}" is not a number` };
      return { value: n };
    }
    case "integer": {
      const n = cleanNumber(trimmed);
      if (!Number.isFinite(n)) return { value: null, error: `${spec.label} "${raw}" is not a number` };
      if (!Number.isInteger(n)) return { value: null, error: `${spec.label} "${raw}" must be a whole number` };
      return { value: n };
    }
    case "boolean": {
      const v = trimmed.toLowerCase();
      if (TRUE_SET.has(v)) return { value: true };
      if (FALSE_SET.has(v)) return { value: false };
      return { value: null, error: `${spec.label} "${raw}" must be yes/no` };
    }
    case "date": {
      if (!isYmd(trimmed)) return { value: null, error: `${spec.label} "${raw}" must be a date (YYYY-MM-DD)` };
      return { value: trimmed };
    }
    case "enum": {
      const v = trimmed.toLowerCase();
      if (spec.enumValues && !spec.enumValues.includes(v)) {
        return { value: null, error: `${spec.label} "${raw}" must be one of: ${spec.enumValues.join(", ")}` };
      }
      return { value: v };
    }
    default:
      // text / brand / department — kept as the trimmed string.
      return { value: trimmed };
  }
}

// Normalise a whole mapped record (canonical key → raw string) into a typed
// record + a flat error list. Only columns the def knows about are considered.
export function normalizeRecord(
  def: ImporterDef,
  raw: Record<string, string | undefined>
): { values: NormRecord; errors: string[] } {
  const values: NormRecord = {};
  const errors: string[] = [];
  for (const spec of def.columns) {
    const { value, error } = normalizeField(spec, raw[spec.key]);
    values[spec.key] = value;
    if (error) errors.push(error);
  }
  if (def.validateRecord && errors.length === 0) {
    errors.push(...def.validateRecord(values));
  }
  return { values, errors };
}

// The dedup identity of a row, as one or more keys. A row is a duplicate when
// ANY of its keys collides with an already-committed row or an earlier row in
// the same file. Brand/department ids come from the resolved lookup so a
// name-only CSV keys on the same id the table does.
export function dedupKeys(entity: EntityType, values: NormRecord, resolved: Resolved): string[] {
  const s = (v: NormValue) => (v == null ? "" : String(v).trim().toLowerCase());
  switch (entity) {
    case "products": {
      // Matches unique (org_id, brand_id, sku): a null brand groups as "".
      const sku = s(values.sku);
      if (!sku) return [];
      return [`p:${resolved.brandId ?? ""}:${sku}`];
    }
    case "creators": {
      // email OR phone OR handle+platform — any collision blocks the row.
      const keys: string[] = [];
      const email = s(values.email);
      if (email) keys.push(`e:${email}`);
      const phone = String(values.phone ?? "").trim();
      if (phone) keys.push(`ph:${phone}`);
      const handle = s(values.handle);
      if (handle) keys.push(`h:${s(values.platform) || "tiktok"}:${handle}`);
      return keys;
    }
    case "metric_entries": {
      // Matches metric_entries_key_uq (brand null = org-level sentinel).
      const mk = s(values.metric_key);
      if (!mk || !values.period_start || !values.period_end) return [];
      return [`m:${mk}:${resolved.brandId ?? "org"}:${values.period_start}:${values.period_end}`];
    }
    case "metrics_snapshots": {
      if (!values.period_start || !values.period_end) return [];
      return [`s:${resolved.departmentId ?? ""}:${resolved.brandId ?? ""}:${values.period_start}:${values.period_end}`];
    }
    case "affiliate_performance": {
      // Matches creator_posts_org_creator_posturl_uniq (org, creator_id, post_url).
      // The commit UPSERTS on this key, so a re-imported file is NOT blocked against
      // the DB (loadContext seeds no existing keys for this entity); this key only
      // guards against the SAME post_url appearing twice WITHIN one file, where the
      // later copy is a genuine data error the operator should see.
      const url = s(values.post_url);
      if (!resolved.creatorId || !url) return [];
      return [`a:${resolved.creatorId}:${url}`];
    }
  }
}

// A short human label for a row in the preview table.
export function describeRow(entity: EntityType, values: NormRecord): string {
  switch (entity) {
    case "products":
      return [values.sku, values.product_name].filter(Boolean).join(" — ") || "(row)";
    case "creators":
      return [values.name, values.handle].filter(Boolean).join(" · ") || "(row)";
    case "metric_entries":
      return [values.metric_key, values.period_start && `${values.period_start}→${values.period_end}`]
        .filter(Boolean)
        .join(" ") || "(row)";
    case "metrics_snapshots":
      return [values.department || "org", values.period_start && `${values.period_start}→${values.period_end}`]
        .filter(Boolean)
        .join(" ") || "(row)";
    case "affiliate_performance":
      return [values.creator_handle, values.post_url].filter(Boolean).join(" · ") || "(row)";
  }
}

// ── Column aliases ───────────────────────────────────────────────────────────

// The Products importer's header vocabulary, exported as ONE constant so other
// importers (or a future entity) extend the same spellings instead of
// re-declaring them. Matched case/space/punctuation-insensitively — see
// normalizeHeader — so "STOCK NO.", "Stock No", and "stock_no" all fold to the
// same key. NOTHING is ever aliased to `status`: status is active/archived only,
// decided by that column's own value, never inferred from another header (a
// "STOCK LEVEL STATUS" column must NOT hijack the product's status).
export const PRODUCT_ALIASES: Record<string, string[]> = {
  sku: ["stock no", "stock number", "item code", "item no", "article no", "product code", "code", "model", "product_sku"],
  product_name: ["product description", "description", "item name", "particulars", "product", "name", "title"],
  selling_price: ["srp", "retail price", "price", "unit price", "list price"],
  barcode: ["ean", "upc", "bar code", "gtin"],
  category: ["cat", "product category"],
  brand: ["brand name", "supplier", "vendor", "client"],
};

// ── The importer catalogue ──────────────────────────────────────────────────

function checkPeriod(values: NormRecord): string[] {
  const a = values.period_start;
  const b = values.period_end;
  if (typeof a === "string" && typeof b === "string" && b < a) {
    return ["period_end is before period_start"];
  }
  return [];
}

export const IMPORTERS: Record<EntityType, ImporterDef> = {
  products: {
    entity: "products",
    label: "Products",
    description: "New products into the Product Master, with an optional opening stock count into Stock Levels.",
    ownerHint: "Warehouse team or leadership",
    dedupLabel: "SKU within brand",
    columns: [
      { key: "sku", label: "SKU", type: "text", required: true, aliases: PRODUCT_ALIASES.sku },
      { key: "product_name", label: "Product name", type: "text", aliases: PRODUCT_ALIASES.product_name },
      // Brand is REQUIRED for products and resolved to an existing client (exact
      // or prefix, e.g. "LIAO" → "Liao Philippines"). A product NEVER imports with
      // a null brand — an unmapped brand column refuses the whole file, and a 0/>1
      // brand match aborts with the candidates listed (see engine.resolveProductBrands).
      { key: "brand", label: "Brand", type: "brand", required: true, aliases: PRODUCT_ALIASES.brand, note: "matched to an existing client by name or prefix; required — never null" },
      { key: "category", label: "Category", type: "text", aliases: PRODUCT_ALIASES.category },
      { key: "variant", label: "Variant", type: "text", aliases: ["variation"] },
      { key: "barcode", label: "Barcode", type: "text", aliases: PRODUCT_ALIASES.barcode },
      { key: "warehouse_location", label: "Location", type: "text", aliases: ["location", "bin", "shelf"] },
      { key: "unit_value", label: "Unit value", type: "number", aliases: ["value"] },
      { key: "cost", label: "Cost", type: "number", aliases: ["unit_cost", "landed_cost"] },
      { key: "selling_price", label: "Selling price", type: "number", aliases: PRODUCT_ALIASES.selling_price },
      { key: "reorder_point", label: "Reorder point", type: "integer", aliases: ["reorder"] },
      { key: "target_cover_days", label: "Target cover days", type: "integer", aliases: ["cover_days"] },
      { key: "status", label: "Status", type: "text", note: "defaults to active" },
      { key: "is_fragile", label: "Fragile", type: "boolean" },
      { key: "is_perishable", label: "Perishable", type: "boolean" },
      { key: "is_high_value", label: "High value", type: "boolean" },
      { key: "stocked_at", label: "Stocked at", type: "date" },
      { key: "expiry_date", label: "Expiry date", type: "date" },
      { key: "notes", label: "Notes", type: "text" },
      { key: "current_stock", label: "Opening stock", type: "integer", aliases: ["stock", "on_hand", "quantity", "qty"], note: "→ stock_levels" },
      { key: "reserved_stock", label: "Reserved", type: "integer", note: "→ stock_levels" },
      { key: "damaged_stock", label: "Damaged", type: "integer", note: "→ stock_levels" },
      { key: "in_transit", label: "In transit", type: "integer", note: "→ stock_levels" },
      { key: "reorder_level", label: "Reorder level", type: "integer", note: "→ stock_levels" },
    ],
  },

  creators: {
    entity: "creators",
    label: "Creators",
    description: "Affiliate creators / prospects. Blocked as duplicates when email, phone, or handle already exists.",
    ownerHint: "Business Development / Affiliate or leadership",
    dedupLabel: "email / phone / handle",
    columns: [
      { key: "name", label: "Name", type: "text", required: true, aliases: ["creator_name", "full_name"] },
      { key: "platform", label: "Platform", type: "text", aliases: ["channel"], note: "defaults to tiktok" },
      { key: "handle", label: "Handle", type: "text", aliases: ["username", "tiktok_handle", "ig_handle", "social", "socials"] },
      { key: "category", label: "Category", type: "text", aliases: ["niche"] },
      { key: "follower_count", label: "Followers", type: "integer", aliases: ["followers", "following"] },
      { key: "email", label: "Email", type: "text", aliases: ["email_address"] },
      { key: "phone", label: "Phone", type: "text", aliases: ["mobile", "contact_number", "phone_number"] },
      { key: "viber", label: "Viber", type: "text" },
      { key: "tier", label: "Tier", type: "text" },
      { key: "status", label: "Status", type: "text", note: "defaults to prospect" },
      { key: "attributed_gmv", label: "Attributed GMV", type: "number", aliases: ["gmv"] },
      { key: "posts_committed", label: "Posts committed", type: "integer", aliases: ["commitment"] },
      { key: "notes", label: "Notes", type: "text" },
    ],
  },

  metric_entries: {
    entity: "metric_entries",
    label: "Historical metrics (manual floor)",
    description: "Hand-recorded metric values into metric_entries as origin='manual'. One row per metric / brand / period.",
    ownerHint: "Leadership only",
    dedupLabel: "metric · brand · period",
    validateRecord: checkPeriod,
    columns: [
      { key: "metric_key", label: "Metric key", type: "text", required: true, aliases: ["metric", "key"], note: "e.g. gmv, orders, units" },
      { key: "brand", label: "Brand", type: "brand", aliases: ["brand_name", "client"], note: "blank = org-level" },
      { key: "period_start", label: "Period start", type: "date", required: true, aliases: ["start", "from", "period"] },
      { key: "period_end", label: "Period end", type: "date", required: true, aliases: ["end", "to"] },
      { key: "manual_value", label: "Value", type: "number", required: true, aliases: ["value", "amount", "manual"] },
    ],
  },

  metrics_snapshots: {
    entity: "metrics_snapshots",
    label: "Scorecard history (snapshots)",
    description: "Historical department scorecards into metrics_snapshots (GMV impact, efficiency, quality, capacity).",
    ownerHint: "Leadership only",
    dedupLabel: "department · brand · period",
    validateRecord: checkPeriod,
    columns: [
      { key: "department", label: "Department", type: "department", aliases: ["dept"], note: "matched by name; blank = org-level" },
      { key: "brand", label: "Brand", type: "brand", aliases: ["brand_name", "client"] },
      { key: "gmv_impact", label: "GMV impact", type: "number", aliases: ["gmv"] },
      { key: "efficiency", label: "Efficiency", type: "number" },
      { key: "quality_score", label: "Quality score", type: "number", aliases: ["quality"] },
      { key: "capacity_utilization", label: "Capacity utilization", type: "number", aliases: ["capacity", "utilization"] },
      { key: "period_start", label: "Period start", type: "date", required: true, aliases: ["start", "from"] },
      { key: "period_end", label: "Period end", type: "date", required: true, aliases: ["end", "to"] },
    ],
  },

  affiliate_performance: {
    entity: "affiliate_performance",
    label: "Affiliate performance (Seller Center)",
    description:
      "Seller Center → Affiliate → Analytics export. Each row is one creator's content: attributed GMV / orders / commission → creator_posts (upserted on post URL), rolled up into the creator's attributed GMV. Matches EXISTING creators by handle — it never creates one.",
    ownerHint: "Business Development / Affiliate or leadership",
    dedupLabel: "post URL within creator",
    columns: [
      {
        key: "creator_handle",
        label: "Creator handle",
        type: "text",
        required: true,
        aliases: ["handle", "username", "user_name", "creator_username", "affiliate_username", "affiliate_handle", "tiktok_handle", "creator", "creator_name"],
        note: "matched to an EXISTING creator by handle; an unknown handle is reported, never created",
      },
      {
        key: "post_url",
        label: "Post URL",
        type: "text",
        required: true,
        aliases: ["content_url", "video_url", "url", "link", "post", "content", "content_link", "video_link", "post_link", "content_id"],
        note: "the content's permalink OR a stable content ID — the upsert key, so a re-import refreshes not duplicates",
      },
      { key: "platform", label: "Platform", type: "text", aliases: ["channel"], note: "defaults to the creator's platform / tiktok" },
      { key: "posted_at", label: "Posted at", type: "date", aliases: ["date", "post_date", "posted", "publish_date", "content_date"], note: "YYYY-MM-DD; blank keeps the existing / current timestamp" },
      { key: "gmv", label: "Attributed GMV", type: "number", aliases: ["attributed_gmv", "gmv", "sales", "est_gmv", "affiliate_gmv", "content_gmv", "total_gmv"], note: "ATTRIBUTION, not company revenue — never summed into company GMV" },
      { key: "orders", label: "Orders", type: "integer", aliases: ["sku_orders", "order_count", "paid_orders"] },
      { key: "commission", label: "Commission", type: "number", aliases: ["est_commission", "estimated_commission", "commission_amount", "est_commission_amount", "affiliate_commission"] },
    ],
  },
};

export const ENTITY_ORDER: EntityType[] = [
  "products",
  "creators",
  "metric_entries",
  "metrics_snapshots",
  "affiliate_performance",
];

// Auto-map a file's header cells to canonical column keys by normalised name and
// alias. Returns { [headerIndex]: columnKey }. A header that matches nothing is
// left unmapped for the operator to assign (or ignore) in the UI.
export function autoMap(def: ImporterDef, headers: string[]): Record<number, string> {
  const byAlias = new Map<string, string>();
  for (const col of def.columns) {
    byAlias.set(normalizeHeader(col.key), col.key);
    byAlias.set(normalizeHeader(col.label), col.key);
    for (const a of col.aliases ?? []) byAlias.set(normalizeHeader(a), col.key);
  }
  const map: Record<number, string> = {};
  const used = new Set<string>();
  headers.forEach((h, i) => {
    const key = byAlias.get(normalizeHeader(h));
    if (key && !used.has(key)) {
      map[i] = key;
      used.add(key);
    }
  });
  return map;
}
