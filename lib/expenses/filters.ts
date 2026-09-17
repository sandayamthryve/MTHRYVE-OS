// lib/expenses/filters.ts — the ONE place that turns the Expense search/filter
// URL params into a validated filter set and applies them to a Supabase query.
//
// The records page and all three export routes (CSV / XLSX / PDF) call this, so
// what you see on screen and what a filtered export contains are produced by the
// exact same predicate — they can never drift. Nothing here fetches; it only
// validates untrusted params and narrows a query builder.

import { isValidDate } from "@/lib/metrics/dates";
import {
  isAllocation,
  isExpenseStatus,
  isExpenseType,
  isPaymentMethod,
  type Allocation,
  type ExpenseStatus,
  type ExpenseType,
  type PaymentMethod,
} from "./types";

export interface ExpenseFilterParams {
  start?: string;
  end?: string;
  q?: string; // free text: expense_code / reference_number / one-off vendor
  vendor_id?: string;
  brand_id?: string;
  department_id?: string;
  category_id?: string;
  type?: string; // OPEX | CAPEX
  allocation?: string;
  status?: string; // approval / payment status
  payment_method?: string;
  encoder_id?: string;
}

export interface ExpenseFilters {
  start: string | null;
  end: string | null;
  q: string | null;
  vendorId: string | null;
  brandId: string | null;
  departmentId: string | null;
  categoryId: string | null;
  type: ExpenseType | null;
  allocation: Allocation | null;
  status: ExpenseStatus | null;
  paymentMethod: PaymentMethod | null;
  encoderId: string | null;
}

const uuid = (v: string | undefined | null): string | null => {
  const s = (v ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : null;
};

// Parse untrusted query params into a concrete, validated filter set. Anything
// malformed is dropped to null (i.e. "no filter on that field") rather than
// erroring — a bad deep link degrades to a broader result, never a 500.
export function parseExpenseFilters(sp: ExpenseFilterParams | undefined): ExpenseFilters {
  const q = (sp?.q ?? "").trim();
  return {
    start: isValidDate(sp?.start) ? sp!.start! : null,
    end: isValidDate(sp?.end) ? sp!.end! : null,
    q: q ? q.slice(0, 100) : null,
    vendorId: uuid(sp?.vendor_id),
    brandId: uuid(sp?.brand_id),
    departmentId: uuid(sp?.department_id),
    categoryId: uuid(sp?.category_id),
    type: isExpenseType(sp?.type) ? sp!.type! : null,
    allocation: isAllocation(sp?.allocation) ? sp!.allocation! : null,
    status: isExpenseStatus(sp?.status) ? sp!.status! : null,
    paymentMethod: isPaymentMethod(sp?.payment_method) ? sp!.payment_method! : null,
    encoderId: uuid(sp?.encoder_id),
  };
}

// Convenience for the export routes: parse straight from a URLSearchParams,
// mapping the query keys to the same field names the records page uses.
export function parseExpenseFiltersFromURL(sp: URLSearchParams): ExpenseFilters {
  const g = (k: string) => sp.get(k) ?? undefined;
  return parseExpenseFilters({
    start: g("start"),
    end: g("end"),
    q: g("q"),
    vendor_id: g("vendor_id"),
    brand_id: g("brand_id"),
    department_id: g("department_id"),
    category_id: g("category_id"),
    type: g("type"),
    allocation: g("allocation"),
    status: g("status"),
    payment_method: g("payment_method"),
    encoder_id: g("encoder_id"),
  });
}

// True when any narrowing filter (beyond the date window) is active — lets the
// UI show a "Clear filters" affordance only when there's something to clear.
export function hasActiveFilters(f: ExpenseFilters): boolean {
  return Boolean(
    f.q ||
      f.vendorId ||
      f.brandId ||
      f.departmentId ||
      f.categoryId ||
      f.type ||
      f.allocation ||
      f.status ||
      f.paymentMethod ||
      f.encoderId
  );
}

// Escape a value for a PostgREST `or=(...)` ILIKE group. Commas and parentheses
// would otherwise break out of the filter grammar; strip them and wrap in %.
function ilikeToken(v: string): string {
  return `%${v.replace(/[,()*%]/g, " ").trim()}%`;
}

// Narrow a Supabase query builder for `expenses` by the parsed filters. The
// date window uses transaction_date (the ledger date, not the encode date). Text
// search spans expense_code, reference_number and the one-off vendor name.
// Returns the same builder for chaining. `q` (the shim query type) stays `any`
// because the expenses table isn't in the generated Database types.
export function applyExpenseFilters<Q>(query: Q, f: ExpenseFilters): Q {
  let q = query as any;
  if (f.start) q = q.gte("transaction_date", f.start);
  if (f.end) q = q.lte("transaction_date", f.end);
  if (f.vendorId) q = q.eq("vendor_id", f.vendorId);
  if (f.brandId) q = q.eq("brand_id", f.brandId);
  if (f.departmentId) q = q.eq("department_id", f.departmentId);
  if (f.categoryId) q = q.eq("category_id", f.categoryId);
  if (f.type) q = q.eq("type", f.type);
  if (f.allocation) q = q.eq("allocation", f.allocation);
  if (f.status) q = q.eq("status", f.status);
  if (f.paymentMethod) q = q.eq("payment_method", f.paymentMethod);
  if (f.encoderId) q = q.eq("encoded_by", f.encoderId);
  if (f.q) {
    const tok = ilikeToken(f.q);
    q = q.or(
      `expense_code.ilike.${tok},reference_number.ilike.${tok},vendor_name_oneoff.ilike.${tok}`
    );
  }
  return q as Q;
}

// Rebuild a query string from the active filters (used to carry the current
// filter set onto the export links so an export matches what's on screen).
export function filtersToQueryString(f: ExpenseFilters): string {
  const p = new URLSearchParams();
  if (f.start) p.set("start", f.start);
  if (f.end) p.set("end", f.end);
  if (f.q) p.set("q", f.q);
  if (f.vendorId) p.set("vendor_id", f.vendorId);
  if (f.brandId) p.set("brand_id", f.brandId);
  if (f.departmentId) p.set("department_id", f.departmentId);
  if (f.categoryId) p.set("category_id", f.categoryId);
  if (f.type) p.set("type", f.type);
  if (f.allocation) p.set("allocation", f.allocation);
  if (f.status) p.set("status", f.status);
  if (f.paymentMethod) p.set("payment_method", f.paymentMethod);
  if (f.encoderId) p.set("encoder_id", f.encoderId);
  return p.toString();
}
