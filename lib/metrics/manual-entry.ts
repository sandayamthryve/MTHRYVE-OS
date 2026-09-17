// lib/metrics/manual-entry.ts — the ONE sanctioned manual-floor upsert.
//
// Writing a human-recorded metric number (manual_value) is the "floor" half of
// the Hybrid Metrics Floor (migration 0025_hybrid_metrics_floor). It has exactly
// one code path so every surface that records a floor — the analytics Encode
// panel and the mobile Quick-Entry capture — behaves identically:
//   • the metric must exist in the caller's catalog for that department, and
//     must NOT be a derived/formula metric (those are computed at read time);
//   • only manual_value / origin='manual' / entered_by / note are written —
//     api_value is NEVER in the payload, so the sync's overlay is never touched;
//   • a missing value is null, never a fabricated 0 (the caller resolves that).
//
// All writes run on the REQUEST-SCOPED RLS client the caller passes in; RLS is
// the real boundary (metric_entries_org_insert / _org_update scope to the org).

import type { SessionProfile } from "@/lib/auth/session";

export interface ManualEntryInput {
  metric_key: string;
  department: string;
  brand_id: string | null;
  period_start: string;
  period_end: string;
  /** The human floor to set, or null to clear it. Never coerced from garbage. */
  manual_value: number | null;
  note: string | null;
  /**
   * How this floor came to be recorded. Defaults to 'manual' (typed by hand). A
   * 'vision' value is a Snap-to-fill reading the human REVIEWED and accepted — it
   * still travels the one sanctioned manual path (manual_value + entered_by), it
   * just records that the number was first read off a photo. api_value is still
   * never touched here.
   */
  origin?: string;
}

export type ManualEntryResult =
  | { ok: true; id: string | null; action: "updated" | "inserted" }
  | { ok: false; error: string; status: number };

// metric_catalog / metric_entries carry columns not all present in the generated
// Database types, so — like the rest of the app — we reach them through a minimal
// cast shim on the caller's RLS client.
type Db = { from: (t: string) => any };

// Upsert one manual metric floor. `supabase` is the caller's RLS client (server
// component / route handler / server action). Returns a typed result the caller
// maps to an HTTP status or a UI state — it never throws for the expected
// validation failures.
export async function upsertManualEntry(
  supabase: unknown,
  profile: Pick<SessionProfile, "id" | "org_id">,
  input: ManualEntryInput
): Promise<ManualEntryResult> {
  const db = supabase as Db;

  // Only 'manual' or 'vision' may be recorded through this human path — both are
  // hand-confirmed floors. Anything else falls back to 'manual' (the sync owns
  // 'api'/'reconciled'). Keeps the write honest even if a caller passes garbage.
  const origin = input.origin === "vision" ? "vision" : "manual";

  // The metric must exist in the caller's catalog for this department and must
  // not be a derived (CALCULATED) metric — those are computed at read time and
  // never encoded.
  const { data: catRow } = await db
    .from("metric_catalog")
    .select("metric_key, formula")
    .eq("metric_key", input.metric_key)
    .eq("department", input.department)
    .maybeSingle();
  if (!catRow) {
    return { ok: false, error: "Unknown metric for this department.", status: 400 };
  }
  if ((catRow as { formula: string | null }).formula) {
    return { ok: false, error: "Calculated metrics cannot be encoded.", status: 400 };
  }

  // Manual upsert against the partial unique keys (brand vs shop). We do a
  // find-then-update/insert rather than ON CONFLICT because the two uniqueness
  // domains use partial indexes. Only manual_value / origin / entered_by / note
  // are written — api_value is never in the payload.
  let find = db
    .from("metric_entries")
    .select("id")
    .eq("metric_key", input.metric_key)
    .eq("period_start", input.period_start)
    .eq("period_end", input.period_end);
  find = input.brand_id ? find.eq("brand_id", input.brand_id) : find.is("brand_id", null);
  const { data: existing } = await find.maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    const { error } = await db
      .from("metric_entries")
      // `as never` per the codebase's @supabase/ssr write-inference convention.
      .update({ manual_value: input.manual_value, origin, entered_by: profile.id, note: input.note } as never)
      .eq("id", id);
    if (error) {
      // Log the raw DB detail server-side; return a generic message (no leak).
      console.error("[metrics/manual-entry.update]", error);
      return { ok: false, error: "Could not save the entry.", status: 400 };
    }
    return { ok: true, id, action: "updated" };
  }

  const { data: inserted, error } = await db
    .from("metric_entries")
    // `as never` per the codebase's @supabase/ssr write-inference convention.
    .insert({
      org_id: profile.org_id,
      metric_key: input.metric_key,
      department: input.department,
      brand_id: input.brand_id,
      period_start: input.period_start,
      period_end: input.period_end,
      manual_value: input.manual_value,
      origin,
      entered_by: profile.id,
      note: input.note,
    } as never)
    .select("id")
    .maybeSingle();
  if (error) {
    // Log the raw DB detail server-side; return a generic message (no leak).
    console.error("[metrics/manual-entry.insert]", error);
    return { ok: false, error: "Could not save the entry.", status: 400 };
  }
  return { ok: true, id: (inserted as { id: string } | null)?.id ?? null, action: "inserted" };
}
