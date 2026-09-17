// VAT and Net on an expense.
//
// The calibration report gives two rules:
//
//   Net = Gross − VAT
//   VAT = Gross ÷ 1.12 × 12%
//
// The second is the Philippine VAT-inclusive back-out: a gross figure that
// already contains 12% VAT is divided by 1.12 to recover the VAT-exclusive
// base, and 12% of that base is the VAT. Equivalently VAT = Gross × 12/112,
// which is the form used below because it avoids a second rounding step.
//
// The report also says the system VALIDATES the encoded VAT against that
// expectation — so a VAT that is entered rather than computed is checked, not
// overwritten. Some expenses are legitimately zero-rated, VAT-exempt, or carry
// a supplier's own rounding, and silently replacing the encoder's figure would
// destroy a real number and make the ledger disagree with the receipt.

export const VAT_RATE = 0.12;

/** Rounds to centavos. Money must not carry float dust into the ledger. */
function toCentavos(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** The VAT contained in a VAT-inclusive gross amount. */
export function expectedVat(gross: number): number {
  if (!Number.isFinite(gross) || gross <= 0) return 0;
  return toCentavos((gross * VAT_RATE) / (1 + VAT_RATE));
}

/** Net = Gross − VAT, using the VAT actually recorded. */
export function netAmount(gross: number, vat: number): number {
  if (!Number.isFinite(gross)) return 0;
  const v = Number.isFinite(vat) ? vat : 0;
  return toCentavos(gross - v);
}

export type VatCheck =
  | { ok: true; expected: number; variance: 0 }
  | { ok: false; expected: number; variance: number; reason: string };

/**
 * Checks an encoded VAT against the inclusive-VAT expectation.
 *
 * `tolerance` is in currency units and defaults to one centavo, which absorbs
 * the difference between our rounding and a supplier's without waving through a
 * real discrepancy. A zero VAT passes: zero-rated and exempt purchases are
 * ordinary, and flagging them would train encoders to ignore the warning.
 */
export function checkVat(gross: number, vat: number, tolerance = 0.01): VatCheck {
  const expected = expectedVat(gross);

  if (!Number.isFinite(vat) || vat < 0) {
    return { ok: false, expected, variance: expected, reason: "VAT must be zero or a positive amount." };
  }
  if (vat > gross) {
    return { ok: false, expected, variance: toCentavos(vat - gross), reason: "VAT cannot exceed the gross amount." };
  }
  // Zero-rated / exempt — a deliberate zero, not a mistake.
  if (vat === 0) return { ok: true, expected, variance: 0 };

  const variance = toCentavos(Math.abs(vat - expected));
  if (variance <= tolerance) return { ok: true, expected, variance: 0 };

  return {
    ok: false,
    expected,
    variance,
    reason: `VAT is ${variance.toFixed(2)} off the ${(VAT_RATE * 100).toFixed(0)}% inclusive expectation of ${expected.toFixed(2)}.`,
  };
}
