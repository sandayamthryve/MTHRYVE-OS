import { describe, expect, it } from "vitest";
import { BULK_MAX, planBulkEdit } from "./bulk-edit";

const STATUSES = new Set(["active", "paused", "discontinued", "archived"]);
const plan = (over: Partial<Parameters<typeof planBulkEdit>[0]> = {}) =>
  planBulkEdit({ ids: ["a"], field: "status", value: "active", knownStatuses: STATUSES, ...over });

describe("planBulkEdit", () => {
  it("accepts a normal edit", () => {
    expect(plan()).toEqual({ ids: ["a"], field: "status", value: "active" });
  });

  it("refuses a field outside the allowlist", () => {
    // The point of the allowlist: these five are editable per row and must not
    // be writable across a selection.
    for (const field of ["sku", "product_name", "variant", "barcode", "cost", "selling_price"]) {
      expect(plan({ field })).toBeNull();
    }
    // And nothing invented.
    for (const field of ["", "org_id", "id", "__proto__", "status; drop table"]) {
      expect(plan({ field })).toBeNull();
    }
  });

  it("refuses an empty selection", () => {
    expect(plan({ ids: [] })).toBeNull();
    // Blank and whitespace ids are not a selection either.
    expect(plan({ ids: ["", "   "] })).toBeNull();
  });

  it("caps the number of rows one statement may touch", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
    expect(plan({ ids: ids(BULK_MAX) })).not.toBeNull();
    expect(plan({ ids: ids(BULK_MAX + 1) })).toBeNull();
  });

  it("counts duplicates once, so a repeated id cannot smuggle past the cap", () => {
    const result = plan({ ids: ["a", "a", "b", " b ", "a"] });
    expect(result?.ids).toEqual(["a", "b"]);
    // Over the cap only when the DISTINCT ids are.
    expect(plan({ ids: Array(BULK_MAX + 50).fill("a") })?.ids).toEqual(["a"]);
  });

  it("refuses a status the rest of the page cannot read", () => {
    expect(plan({ value: "active" })).not.toBeNull();
    expect(plan({ value: "retired" })).toBeNull();
    expect(plan({ value: "ACTIVE" })).toBeNull();
    // Status is never clearable — a product always has one.
    expect(plan({ value: "" })).toBeNull();
    expect(plan({ value: "   " })).toBeNull();
  });

  it("clears the optional fields on a blank value, and only those", () => {
    for (const field of ["brand_id", "category", "warehouse_location"]) {
      expect(plan({ field, value: "" })).toEqual({ ids: ["a"], field, value: null });
      expect(plan({ field, value: "   " })).toEqual({ ids: ["a"], field, value: null });
    }
  });

  it("trims the value it writes", () => {
    expect(plan({ field: "category", value: "  Snacks  " })?.value).toBe("Snacks");
  });
});
