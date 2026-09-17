// What a Product Master bulk edit is allowed to do.
//
// This is the guard for a statement that writes many rows at once, so it lives
// here as a pure function rather than inline in the page: the interesting cases
// are the ones the UI cannot produce — a forged field name, an id list longer
// than any page, a status string that no filter or badge can read — and those
// are only reachable from a test.
//
// The rule throughout is fail closed. Anything not explicitly allowed returns
// null, and the caller writes nothing.

/**
 * The only fields a bulk edit may set.
 *
 * Deliberately narrow, and the narrowness is the feature. Name, SKU, variant
 * and barcode identify a single product — a bulk write of them either trips the
 * (org_id, brand_id, sku) unique index or collapses several products onto one
 * identity. Cost and selling price are per-product facts that almost nobody
 * means to flatten across a selection. What remains is the four grouping
 * fields, where setting many rows to one value is the actual intent.
 */
export const BULK_FIELDS = ["brand_id", "category", "warehouse_location", "status"] as const;
export type BulkField = (typeof BULK_FIELDS)[number];

/** Clearing is meaningful for optional fields. A product always has a status. */
export const BULK_CLEARABLE = new Set<BulkField>(["brand_id", "category", "warehouse_location"]);

/**
 * A ceiling on one statement. The UI cannot select more than a page of rows, so
 * this only ever catches a hand-built request.
 */
export const BULK_MAX = 500;

export function isBulkField(value: string): value is BulkField {
  return (BULK_FIELDS as readonly string[]).includes(value);
}

export interface BulkEditPlan {
  ids: string[];
  field: BulkField;
  /** null clears the column. Only ever null for a clearable field. */
  value: string | null;
}

/**
 * Validate a requested bulk edit, returning the write to perform or null.
 *
 * `knownStatuses` is passed in rather than imported so the page stays the one
 * place that defines the status vocabulary — if a status is added there, this
 * accepts it without a second list to keep in step.
 */
export function planBulkEdit(input: {
  ids: readonly string[];
  field: string;
  value: string;
  knownStatuses: ReadonlySet<string>;
}): BulkEditPlan | null {
  const { field, knownStatuses } = input;
  if (!isBulkField(field)) return null;

  // Deduplicated: a repeated id is harmless in an `in (...)` but makes the
  // count lie, and the count is what BULK_MAX is judging.
  const ids = Array.from(new Set(input.ids.map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0 || ids.length > BULK_MAX) return null;

  const raw = input.value.trim();
  if (!raw && !BULK_CLEARABLE.has(field)) return null;
  // An unknown status would write a value the filters and badges cannot read.
  if (field === "status" && !knownStatuses.has(raw)) return null;

  return { ids, field, value: raw === "" ? null : raw };
}
