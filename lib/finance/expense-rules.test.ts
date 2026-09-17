import { describe, expect, it } from "vitest";
import {
  compareExpenseCodes,
  formatExpenseCode,
  isExpenseCode,
  parseExpenseCode,
} from "./expense-code";
import { checkVat, expectedVat, netAmount, VAT_RATE } from "./expense-vat";

// Expectations transcribed from the Finance calibration report, not derived
// from the implementation.

describe("expense code — EXP000001-2026", () => {
  it("formats to the report's shape", () => {
    expect(formatExpenseCode(1, 2026)).toBe("EXP000001-2026");
    expect(formatExpenseCode(42, 2026)).toBe("EXP000042-2026");
    expect(formatExpenseCode(999_999, 2026)).toBe("EXP999999-2026");
  });

  it("widens rather than truncates past six digits", () => {
    // Truncating would re-issue a code that already exists.
    expect(formatExpenseCode(1_000_000, 2026)).toBe("EXP1000000-2026");
  });

  it("rejects sequences and years that cannot name an expense", () => {
    expect(() => formatExpenseCode(0, 2026)).toThrow();
    expect(() => formatExpenseCode(-1, 2026)).toThrow();
    expect(() => formatExpenseCode(1.5, 2026)).toThrow();
    expect(() => formatExpenseCode(1, 26)).toThrow();
  });

  it("round-trips through parse", () => {
    expect(parseExpenseCode("EXP000001-2026")).toEqual({ sequence: 1, year: 2026 });
    expect(parseExpenseCode("  EXP000042-2025  ")).toEqual({ sequence: 42, year: 2025 });
  });

  it("refuses shapes that are not codes", () => {
    for (const bad of ["EXP1-2026", "EXP000001-26", "exp000001-2026", "EXP000000-2026", "", "EXP000001"]) {
      expect(parseExpenseCode(bad), bad).toBeNull();
      expect(isExpenseCode(bad), bad).toBe(false);
    }
  });

  it("orders by year before sequence", () => {
    // Plain string ordering puts EXP000002-2025 after EXP000001-2026, which is
    // backwards in time.
    const sorted = ["EXP000001-2026", "EXP000002-2025"].sort(compareExpenseCodes);
    expect(sorted).toEqual(["EXP000002-2025", "EXP000001-2026"]);
  });
});

describe("VAT — inclusive back-out at 12%", () => {
  it("recovers the VAT contained in a gross amount", () => {
    // 1120 inclusive of 12% = 1000 base + 120 VAT.
    expect(expectedVat(1120)).toBe(120);
    expect(netAmount(1120, 120)).toBe(1000);
  });

  it("matches gross x 12/112 and rounds to centavos", () => {
    const gross = 9_999.99;
    expect(expectedVat(gross)).toBeCloseTo((gross * VAT_RATE) / 1.12, 2);
  });

  it("treats a non-positive gross as carrying no VAT", () => {
    expect(expectedVat(0)).toBe(0);
    expect(expectedVat(-5)).toBe(0);
  });

  it("passes an encoded VAT that matches", () => {
    expect(checkVat(1120, 120).ok).toBe(true);
  });

  it("passes a zero VAT — zero-rated and exempt purchases are ordinary", () => {
    const result = checkVat(1120, 0);
    expect(result.ok).toBe(true);
    expect(result.expected).toBe(120);
  });

  it("absorbs a centavo of supplier rounding", () => {
    expect(checkVat(1120, 120.01).ok).toBe(true);
    expect(checkVat(1120, 119.99).ok).toBe(true);
  });

  it("flags a VAT that is actually wrong, and says by how much", () => {
    const result = checkVat(1120, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.expected).toBe(120);
      expect(result.variance).toBe(20);
      expect(result.reason).toContain("120.00");
    }
  });

  it("rejects impossible VAT figures", () => {
    expect(checkVat(1120, -1).ok).toBe(false);
    expect(checkVat(1120, 2000).ok).toBe(false);
  });

  it("validates rather than overwrites — the encoded figure survives Net", () => {
    // A supplier's own rounding must reach the ledger, not our expectation.
    expect(netAmount(1120, 119.5)).toBe(1000.5);
  });
});
