// lib/metrics/format.ts — shared display formatters for the metrics layer.
//
// One home for peso / integer / percent / ratio formatting so every GMV surface
// reads identically and honest "no data" placeholders are consistent. Nothing
// here fabricates a value: a null in yields the em-dash placeholder out.

export const EMPTY = "—";

export function peso(n: number, currency = "PHP"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}

export function pesoCompact(n: number, currency = "PHP"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    return `₱${Math.round(n)}`;
  }
}

export function int(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export function pesoOrDash(n: number | null | undefined, currency = "PHP"): string {
  return n == null ? EMPTY : peso(Number(n), currency);
}

export function intOrDash(n: number | null | undefined): string {
  return n == null ? EMPTY : int(Number(n));
}

// A ratio like ROAS → "3.2×", or the em-dash when undefined (divide-by-zero).
export function ratioOrDash(n: number | null | undefined, suffix = "×"): string {
  return n == null ? EMPTY : `${Math.round(Number(n) * 100) / 100}${suffix}`;
}

// A percentage from a 0..100 value → "34%", or the em-dash when null.
export function pctOrDash(n: number | null | undefined, digits = 0): string {
  if (n == null) return EMPTY;
  const v = Math.round(Number(n) * 10 ** digits) / 10 ** digits;
  return `${v}%`;
}
