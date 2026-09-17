// lib/metrics/data.ts — the server-side read layer for the Hybrid Metrics Floor.
//
// Assembles the per-department dashboard: the metric_catalog definitions joined
// to the caller's metric_entries for a brand + period, health dots from the
// existing metric_targets table (thresholds live there — never duplicated here),
// derived CALCULATED metrics computed at read time from sibling entries, and —
// when compare is on — the same values for a comparison period plus a delta.
//
// Real data only. A metric with neither a manual nor an API value has a null
// display_value, which every surface renders as "—" (never a fabricated 0).

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import { healthFor, type TargetRow } from "./health";
import { metricsDepartmentForName } from "./types";
import type {
  CatalogMetric,
  DashboardMetric,
  Origin,
  Unit,
  ValidationStatus,
} from "./types";
import type { Range } from "./dates";

type Client = ReturnType<typeof createServerSupabaseClient>;

// Loose row shims — the query results come back through the RLS-scoped client
// and we shape them into the typed domain objects below.
interface CatalogRow {
  metric_key: string;
  department: string;
  category: string | null;
  label: string;
  unit: string | null;
  lane: string;
  api_source: string | null;
  api_field: string | null;
  formula: string | null;
  direction: string;
  sort_order: number;
  is_active: boolean;
}
interface EntryRow {
  id: string;
  metric_key: string;
  brand_id: string | null;
  manual_value: number | string | null;
  api_value: number | string | null;
  origin: string;
  variance_pct: number | string | null;
  validation_status: string;
  entered_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string | null;
  note: string | null;
}

export interface DashboardData {
  metrics: DashboardMetric[];
  // Keyed by category, preserving catalog sort order within each.
  byCategory: Map<string, DashboardMetric[]>;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// A stable key for the shop-vs-brand entry lookup. brand_id null (shop/org
// level) collapses to the literal "shop".
function entryKey(metricKey: string, brandId: string | null): string {
  return `${metricKey}::${brandId ?? "shop"}`;
}

// Load catalog definitions for a department, active first, in sort order.
export async function getCatalog(
  supabase: Client,
  department: string
): Promise<CatalogMetric[]> {
  const { data } = await supabase
    .from("metric_catalog")
    .select(
      "metric_key, department, category, label, unit, lane, api_source, api_field, formula, direction, sort_order, is_active"
    )
    .eq("department", department)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  return ((data ?? []) as unknown as CatalogRow[]).map((r) => ({
    ...r,
    unit: r.unit as Unit,
    lane: r.lane as CatalogMetric["lane"],
    direction: (r.direction === "down" ? "down" : "up") as "up" | "down",
  }));
}

// ── HAND-ENTERABLE (lane='manual') catalog + scope — the ONE source of truth ──
//
// Both Quick-Entry surfaces (the standalone /quick-entry page AND the Data
// Analytics grid) load their department picker + metric list from this single
// resolver, so the two can never drift apart again.
//
// The bridge is the metrics-floor CODE, exactly as the schema stores it:
//   • metric_catalog.department is the department CODE (e.g. "ecommerce",
//     "live_ops", "warehouse", "creatives", "affiliate") — see the seed in
//     0025_hybrid_metrics_floor.sql. The SAME code the analytics dashboard reads
//     by (/analytics/[department]) and that we write on save, so the picker, the
//     save, and the analytics read all agree on one value with no translation.
//   • A caller's own department comes from users.department_id → departments.name,
//     which is an ORG name ("E-Commerce Ops", "Live Operations"). That name is
//     mapped to the metrics-floor code with metricsDepartmentForName — the ONE
//     correct link, since departments.name and the metric_catalog code taxonomy
//     are different sets. We NEVER filter metric_catalog.department (code) by the
//     org name directly (it would match nothing and leave the grid empty), and we
//     NEVER compare a users.department_id (uuid) against it either.
// The picker options are derived from the catalog itself, so every option is
// guaranteed to filter to real, enterable metrics. RLS scopes every read to org.

// A single hand-enterable metric as the Quick-Entry selectors need it. The
// department rides on the metric (metric_catalog.department, the CODE) so it
// matches on save and on the analytics read with no translation.
export interface ManualCatalogMetric {
  metric_key: string;
  department: string;
  label: string;
  unit: string | null;
}

// The scope a caller may record for, resolved server-side from their profile.
export interface ManualCatalogScope {
  // ceo/coo, or anyone with no department, may enter for ANY team → they get a
  // department picker over every team that has manual metrics. Everyone else is
  // locked to their own department (resolved by NAME → metrics-floor CODE).
  canPickDepartment: boolean;
  // The locked caller's own department CODE (null for a picker-capable caller, or
  // when a scoped caller has no resolvable/metric-bearing department).
  ownDepartment: string | null;
  // Department CODES that have manual metrics, in catalog order — the picker's
  // options for a leader, or just the one own-department for a locked caller.
  departments: string[];
  // The manual metrics in scope: every team's for a leader, the own team's for a
  // locked caller. Empty (never "none configured" wrongly) only when the caller
  // truly has no manual metrics to record.
  catalog: ManualCatalogMetric[];
}

interface ManualCatalogRow {
  metric_key: string;
  department: string;
  label: string;
  unit: string | null;
  sort_order: number;
}

export async function resolveManualCatalogScope(
  supabase: Client,
  profile: { role: string; department_id: string | null }
): Promise<ManualCatalogScope> {
  // Leadership, or anyone without a department, may record for any team.
  const isLeadership = profile.role === "ceo" || profile.role === "coo";
  const allAccess = isLeadership || profile.department_id == null;

  // Resolve the caller's own department NAME (users.department_id → departments
  // .name), then map that org name onto the metrics-floor CODE the catalog stores.
  // metricsDepartmentForName is the only correct bridge between the two taxonomies;
  // filtering the code column by the raw org name would match nothing.
  let ownDepartment: string | null = null;
  if (!allAccess && profile.department_id) {
    const { data: dept } = await supabase
      .from("departments")
      .select("name")
      .eq("id", profile.department_id)
      .maybeSingle();
    ownDepartment = metricsDepartmentForName((dept as { name: string } | null)?.name ?? null);
  }

  // Load the hand-enterable catalog (lane='manual'). Leadership gets every
  // department's manual metrics; a locked user gets only their own department's.
  // A locked user with no resolvable department gets nothing (honest empty).
  let catalog: ManualCatalogMetric[] = [];
  if (allAccess || ownDepartment) {
    let query = supabase
      .from("metric_catalog")
      .select("metric_key, department, label, unit, sort_order")
      .eq("lane", "manual");
    if (!allAccess && ownDepartment) {
      query = query.eq("department", ownDepartment);
    }
    const { data } = await query
      .order("department", { ascending: true })
      .order("sort_order", { ascending: true });

    catalog = ((data ?? []) as unknown as ManualCatalogRow[]).map((r) => ({
      metric_key: r.metric_key,
      department: r.department,
      label: r.label,
      unit: r.unit,
    }));
  }

  // The picker options come from the catalog itself, so every option maps to real
  // metrics. Preserves catalog (alphabetical) order, de-duplicated.
  const departments = Array.from(new Set(catalog.map((m) => m.department)));

  return { canPickDepartment: allAccess, ownDepartment, departments, catalog };
}

// Load metric_entries for a department + brand for one period. brand_id null
// means the shop/org-level rows (IS NULL), otherwise the specific brand.
async function getEntries(
  supabase: Client,
  department: string,
  brandId: string | null,
  range: Range
): Promise<Map<string, EntryRow>> {
  let q = supabase
    .from("metric_entries")
    .select(
      "id, metric_key, brand_id, manual_value, api_value, origin, variance_pct, validation_status, entered_by, approved_by, approved_at, updated_at, note"
    )
    .eq("department", department)
    // AI-spine guardrail: archived entries MUST NOT feed reasoning. getDashboard
    // compares these values against metric_targets to produce the health dots and
    // powers the CSV export — a soft-archived metric would otherwise surface a
    // health judgment (and export row) for a metric that was removed. Fail closed.
    .is("archived_at", null)
    .eq("period_start", range.start)
    .eq("period_end", range.end);
  q = brandId ? q.eq("brand_id", brandId) : q.is("brand_id", null);

  const { data } = await q;
  const map = new Map<string, EntryRow>();
  for (const row of (data ?? []) as unknown as EntryRow[]) {
    map.set(entryKey(row.metric_key, row.brand_id), row);
  }
  return map;
}

// All metric_targets for the org, indexed by metric key (= metric_key). Read
// only — thresholds are authored elsewhere.
async function getTargets(supabase: Client): Promise<Map<string, TargetRow>> {
  const { data } = await supabase
    .from("metric_targets")
    .select("metric, green_min, amber_min, band_low, band_high, direction, target_value");
  const map = new Map<string, TargetRow>();
  for (const t of (data ?? []) as unknown as TargetRow[]) {
    // Prefer a department-scoped row if multiple exist, but org-level is fine as
    // the floor. Last-writer here is acceptable; keys are unique per metric in
    // practice for Phase 1.
    if (!map.has(t.metric)) map.set(t.metric, t);
  }
  return map;
}

// The displayed value + origin for an entry. The manual floor wins when present;
// otherwise the API value; otherwise null (honest empty). The stored `origin`
// is respected for provenance, but a value must exist for it to mean anything.
function display(entry: EntryRow | undefined): {
  value: number | null;
  origin: Origin | null;
} {
  if (!entry) return { value: null, origin: null };
  const manual = num(entry.manual_value);
  const api = num(entry.api_value);
  if (manual != null) {
    // Both present → the stored origin (reconciled/overridden) or plain manual.
    const o = (entry.origin as Origin) || "manual";
    return { value: manual, origin: api != null ? o : "manual" };
  }
  if (api != null) return { value: api, origin: "api" };
  return { value: null, origin: null };
}

// Evaluate a simple derived formula like "ecom.gmv / ecom.orders" against a map
// of metric_key -> display value. Supports one binary operator (+ - * /) over
// two metric keys. Returns null if an operand is missing or a divide-by-zero
// would occur (honest null, never 0).
function evalFormula(
  formula: string,
  values: Map<string, number | null>
): number | null {
  const m = formula.match(/^\s*([\w.]+)\s*([-+*/])\s*([\w.]+)\s*$/);
  if (!m) return null;
  const [, aKey, op, bKey] = m;
  const a = values.get(aKey) ?? null;
  const b = values.get(bKey) ?? null;
  if (a == null || b == null) return null;
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? null : a / b;
    default:
      return null;
  }
}

export interface BuildOpts {
  department: string;
  brandId: string | null;
  range: Range;
  compareRange: Range | null;
  userNames: Map<string, string>;
}

// Assemble the full dashboard model for a department/brand/period.
export async function getDashboard(
  supabase: Client,
  opts: BuildOpts
): Promise<DashboardData> {
  const { department, brandId, range, compareRange, userNames } = opts;

  const [catalog, entries, targets, compareEntries] = await Promise.all([
    getCatalog(supabase, department),
    getEntries(supabase, department, brandId, range),
    getTargets(supabase),
    compareRange
      ? getEntries(supabase, department, brandId, compareRange)
      : Promise.resolve(new Map<string, EntryRow>()),
  ]);

  // First pass: resolve every non-calculated metric's display value, so derived
  // metrics can read sibling values. Same for the compare period.
  const curValues = new Map<string, number | null>();
  const cmpValues = new Map<string, number | null>();
  for (const c of catalog) {
    if (c.formula) continue;
    curValues.set(c.metric_key, display(entries.get(entryKey(c.metric_key, brandId))).value);
    cmpValues.set(
      c.metric_key,
      display(compareEntries.get(entryKey(c.metric_key, brandId))).value
    );
  }
  // Second pass: fill derived values (single level of formula; catalog has no
  // formulas that reference other formulas in Phase 1).
  for (const c of catalog) {
    if (!c.formula) continue;
    curValues.set(c.metric_key, evalFormula(c.formula, curValues));
    cmpValues.set(c.metric_key, evalFormula(c.formula, cmpValues));
  }

  const metrics: DashboardMetric[] = catalog.map((c) => {
    const entry = entries.get(entryKey(c.metric_key, brandId));
    const isCalculated = !!c.formula;

    let value: number | null;
    let origin: Origin | null;
    if (isCalculated) {
      value = curValues.get(c.metric_key) ?? null;
      origin = value != null ? "calculated" : null;
    } else {
      const d = display(entry);
      value = d.value;
      origin = d.origin;
    }

    const target = targets.get(c.metric_key);
    const cmpValue = compareRange ? cmpValues.get(c.metric_key) ?? null : null;
    const delta =
      cmpValue != null && cmpValue !== 0 && value != null
        ? Math.round(((value - cmpValue) / Math.abs(cmpValue)) * 1000) / 10
        : null;

    return {
      ...c,
      entry_id: entry?.id ?? null,
      manual_value: entry ? num(entry.manual_value) : null,
      api_value: entry ? num(entry.api_value) : null,
      display_value: value,
      display_origin: origin,
      variance_pct: entry ? num(entry.variance_pct) : null,
      validation_status: (entry?.validation_status ?? "unvalidated") as ValidationStatus,
      entered_by: entry?.entered_by ?? null,
      entered_by_name: entry?.entered_by ? userNames.get(entry.entered_by) ?? null : null,
      approved_by: entry?.approved_by ?? null,
      approved_at: entry?.approved_at ?? null,
      updated_at: entry?.updated_at ?? null,
      note: entry?.note ?? null,
      health: healthFor(value, target),
      target_value: target ? num(target.target_value) : null,
      compare_value: cmpValue,
      delta_pct: delta,
    };
  });

  const byCategory = new Map<string, DashboardMetric[]>();
  for (const m of metrics) {
    const cat = m.category ?? "other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(m);
  }

  return { metrics, byCategory };
}

// Resolve entered_by uuids to display names for the caller's org (RLS-scoped).
export async function getUserNames(supabase: Client): Promise<Map<string, string>> {
  const { data } = await supabase.from("users").select("id, full_name");
  const map = new Map<string, string>();
  for (const u of (data ?? []) as unknown as { id: string; full_name: string }[]) {
    map.set(u.id, u.full_name);
  }
  return map;
}
