// Expense codes — EXP000001-2026.
//
// Four rules from the calibration report, and each one is a constraint on where
// the number may come from:
//
//   1. Sequential.
//   2. NEVER reused after a delete. So the sequence cannot be derived by
//      counting rows or by taking max(n)+1 — deleting the highest row would
//      hand its number to the next expense. It must come from a monotonic
//      counter that only ever moves forward, which is why allocation belongs to
//      a Postgres sequence (see the expense_code_seq in the schema) rather than
//      to application code.
//   3. The year rolls automatically — the suffix is the year of ENCODING.
//   4. The code is permanent through edits. Changing an expense's transaction
//      date, and with it the year, must not renumber it; the code is assigned
//      once at insert and never recomputed.
//
// This module owns the FORMAT only. It deliberately does not allocate numbers:
// a correct allocator needs the database's atomicity, and anything here that
// looked like one would be a race waiting to happen.

export const EXPENSE_CODE_DIGITS = 6;
export const EXPENSE_CODE_PREFIX = "EXP";

// EXP + 6 digits + "-" + 4-digit year.
const EXPENSE_CODE_RE = /^EXP(\d{6})-(\d{4})$/;

export type ExpenseCodeParts = { sequence: number; year: number };

/** Formats an allocated sequence number and year into the canonical code. */
export function formatExpenseCode(sequence: number, year: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`Expense sequence must be a positive integer, got ${sequence}`);
  }
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new RangeError(`Expense year must be four digits, got ${year}`);
  }
  // Past a million in one year the code would widen rather than truncate: a
  // silently shortened code would collide with an earlier one.
  const digits = String(sequence).padStart(EXPENSE_CODE_DIGITS, "0");
  return `${EXPENSE_CODE_PREFIX}${digits}-${year}`;
}

/** Parses a code back to its parts, or null when it is not a valid code. */
export function parseExpenseCode(code: string): ExpenseCodeParts | null {
  const match = EXPENSE_CODE_RE.exec(code.trim());
  if (!match) return null;
  const sequence = Number(match[1]);
  const year = Number(match[2]);
  // "EXP000000-2026" matches the shape but names no expense.
  if (sequence < 1) return null;
  return { sequence, year };
}

export function isExpenseCode(code: string): boolean {
  return parseExpenseCode(code) !== null;
}

/**
 * Sort key for codes. Year first, then sequence — string ordering alone would
 * put EXP000002-2025 after EXP000001-2026, which is backwards in time.
 */
export function compareExpenseCodes(a: string, b: string): number {
  const pa = parseExpenseCode(a);
  const pb = parseExpenseCode(b);
  if (!pa || !pb) return a.localeCompare(b);
  return pa.year - pb.year || pa.sequence - pb.sequence;
}
