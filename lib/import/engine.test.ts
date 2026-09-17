// Unit tests for the ONE import engine — the exact failure this PR fixes:
// a LIAO-style Seller Center export with two junk title rows above a header on
// row 3 that names its columns "STOCK NO." and "SRP" (not "sku"/"selling_price"),
// with a "BRAND NAME" column carrying "LIAO" (a prefix of the client
// "Liao Philippines"). It must:
//   • parse .xlsx through the same matrix a CSV produces,
//   • detect the header on row 3 (not assume row 1),
//   • alias STOCK NO. → sku and SRP → selling_price, and NEVER map
//     "STOCK LEVEL STATUS" onto the product's status,
//   • resolve LIAO → Liao Philippines (never a null brand),
//   • import all 104 rows, and on a SECOND run of the SAME file import 0 and
//     report 104 duplicates.

import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseSpreadsheet } from "./spreadsheet";
import {
  detectHeaderRow,
  resolveProductBrands,
  classify,
  buildPreview,
  missingRequiredColumns,
  type ImportContext,
  type BrandRow,
} from "./engine";
import { IMPORTERS, autoMap, dedupKeys } from "./registry";

const PRODUCTS = IMPORTERS.products;

// The org's clients. "LIAO" is a strict prefix of exactly one — Liao Philippines.
const BRANDS: BrandRow[] = [
  { id: "brand-liao", name: "Liao Philippines" },
  { id: "brand-basic", name: "Basic City" },
  { id: "brand-star", name: "Star 360" },
];

// Build the exact failing spreadsheet: 2 title rows, header on row 3, 104 data rows.
async function buildLiaoXlsx(rows = 104): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["LIAO PHILIPPINES — MASTER PRICE LIST"]); // junk title row 1
  ws.addRow(["Updated 2026-07-29", "", "confidential"]); // junk title row 2
  ws.addRow([
    "BARCODE",
    "PRODUCT IMAGE",
    "STOCK NO.",
    "PRODUCT DESCRIPTION",
    "INNER",
    "SRP",
    "STOCK LEVEL STATUS",
    "CATEGORY",
    "BRAND NAME",
  ]); // real header, row 3
  for (let i = 1; i <= rows; i++) {
    const n = String(i).padStart(4, "0");
    ws.addRow([
      `48000000${n}`, // barcode
      `img_${n}.jpg`, // product image (ignored)
      `SKU-${n}`, // STOCK NO. → sku
      `Liao Product ${n}`, // PRODUCT DESCRIPTION → product_name
      "12", // INNER (ignored)
      String(50 + i), // SRP → selling_price
      "IN STOCK", // STOCK LEVEL STATUS — must NOT map to status
      "Household", // CATEGORY
      "LIAO", // BRAND NAME → resolves to Liao Philippines
    ]);
  }
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

function emptyCtx(brands: BrandRow[]): ImportContext {
  return {
    brandIdByName: new Map(),
    departmentIdByName: new Map(),
    creatorIdByHandle: new Map(),
    existingKeys: new Set(),
    brands,
    productBrandByValue: new Map(),
  };
}

describe("one import engine — LIAO xlsx with header on row 3", () => {
  it("parses xlsx to a matrix and detects the header on row 3", async () => {
    const buf = await buildLiaoXlsx();
    const matrix = await parseSpreadsheet(buf);
    // 2 title rows + 1 header + 104 data = 107 non-empty rows.
    expect(matrix.length).toBe(107);

    const idx = detectHeaderRow(PRODUCTS, matrix);
    expect(idx).toBe(2); // 0-based → header is the 3rd row
    expect(idx + 1).toBe(3); // 1-based row number reported to the user
  });

  it("aliases STOCK NO.→sku and SRP→selling_price, and never maps status", async () => {
    const matrix = await parseSpreadsheet(await buildLiaoXlsx());
    const headers = matrix[detectHeaderRow(PRODUCTS, matrix)];
    const mapping = autoMap(PRODUCTS, headers);
    const targets = new Set(Object.values(mapping));

    expect(targets.has("sku")).toBe(true);
    expect(targets.has("selling_price")).toBe(true);
    expect(targets.has("product_name")).toBe(true);
    expect(targets.has("brand")).toBe(true);
    expect(targets.has("barcode")).toBe(true);
    expect(targets.has("category")).toBe(true);
    // "STOCK LEVEL STATUS" must be ignored, not folded onto status.
    expect(targets.has("status")).toBe(false);
    // Required columns are all satisfied → no loud refusal.
    expect(missingRequiredColumns(PRODUCTS, mapping)).toHaveLength(0);
  });

  it("resolves LIAO → Liao Philippines (never a null brand)", async () => {
    const matrix = await parseSpreadsheet(await buildLiaoXlsx());
    const headerIdx = detectHeaderRow(PRODUCTS, matrix);
    const headers = matrix[headerIdx];
    const data = matrix.slice(headerIdx + 1);
    const mapping = autoMap(PRODUCTS, headers);

    const res = resolveProductBrands(data, mapping, BRANDS);
    expect(res.ok).toBe(true);
    expect(res.byValue.get("liao")).toBe("brand-liao");
    expect(res.resolved).toEqual([{ value: "LIAO", brand: "Liao Philippines" }]);
  });

  it("imports 104 rows first pass, then 104 duplicates on the SAME file", async () => {
    const matrix = await parseSpreadsheet(await buildLiaoXlsx());
    const headerIdx = detectHeaderRow(PRODUCTS, matrix);
    const headers = matrix[headerIdx];
    const data = matrix.slice(headerIdx + 1);
    const mapping = autoMap(PRODUCTS, headers);

    // ── First import (empty DB) ──
    const ctx1 = emptyCtx(BRANDS);
    const brand = resolveProductBrands(data, mapping, BRANDS);
    expect(brand.ok).toBe(true);
    ctx1.productBrandByValue = brand.byValue;

    const classified1 = classify(PRODUCTS, data, mapping, ctx1, headerIdx + 2);
    const preview1 = buildPreview(PRODUCTS, classified1, mapping);
    expect(preview1.totals.total).toBe(104);
    expect(preview1.totals.valid).toBe(104);
    expect(preview1.totals.duplicates).toBe(0);
    expect(preview1.totals.invalid).toBe(0);

    // Every valid row carries the resolved Liao brand — no null brand_id.
    expect(classified1.every((r) => r.resolved.brandId === "brand-liao")).toBe(true);
    // Line numbers point at the real file rows (data starts on row 4).
    expect(classified1[0].line).toBe(4);
    expect(classified1[103].line).toBe(107);

    // ── Second import of the SAME file (DB now holds those 104) ──
    const ctx2 = emptyCtx(BRANDS);
    ctx2.productBrandByValue = brand.byValue;
    for (const r of classified1) {
      for (const k of dedupKeys("products", r.values, r.resolved)) ctx2.existingKeys.add(k);
    }
    const classified2 = classify(PRODUCTS, data, mapping, ctx2, headerIdx + 2);
    const preview2 = buildPreview(PRODUCTS, classified2, mapping);
    expect(preview2.totals.total).toBe(104);
    expect(preview2.totals.valid).toBe(0);
    expect(preview2.totals.duplicates).toBe(104);
  });
});

describe("brand resolution refuses ambiguous / unknown brands", () => {
  async function dataFor(brandCell: string) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("s");
    ws.addRow(["STOCK NO.", "PRODUCT DESCRIPTION", "SRP", "BRAND NAME"]);
    ws.addRow(["SKU-1", "Item one", "99", brandCell]);
    const matrix = await parseSpreadsheet((await wb.xlsx.writeBuffer()) as unknown as Buffer);
    const idx = detectHeaderRow(PRODUCTS, matrix);
    return { data: matrix.slice(idx + 1), mapping: autoMap(PRODUCTS, matrix[idx]) };
  }

  it("aborts when a brand matches >1 client", async () => {
    const brands: BrandRow[] = [
      { id: "b1", name: "Liao Philippines" },
      { id: "b2", name: "Liao Trading" },
    ];
    const { data, mapping } = await dataFor("LIAO");
    const res = resolveProductBrands(data, mapping, brands);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Liao Philippines");
    expect(res.error).toContain("Liao Trading");
  });

  it("aborts when a brand matches 0 clients", async () => {
    const { data, mapping } = await dataFor("Acme");
    const res = resolveProductBrands(data, mapping, BRANDS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no client matches");
  });
});
