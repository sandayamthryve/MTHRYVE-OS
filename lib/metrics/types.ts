// Shared shapes for the Hybrid Metrics Floor (Phase 1).
//
// Provenance is first-class: every value the dashboard shows carries where it
// came from (`origin`) and, when both a manual and an API value exist, how they
// compare (`validation_status`, `variance_pct`). A missing value is null —
// never a fabricated 0.

export const DEPARTMENTS = [
  "ecommerce",
  "live_ops",
  "warehouse",
  "creatives",
  "affiliate",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  ecommerce: "E-Commerce",
  live_ops: "Live Ops",
  warehouse: "Warehouse & Fulfillment",
  creatives: "Creatives",
  affiliate: "Affiliate",
};

export function isDepartment(v: string): v is Department {
  return (DEPARTMENTS as readonly string[]).includes(v);
}

// Map a person's org department NAME (departments.name, e.g. "E-Commerce Ops",
// "Live Operations") onto the metrics-floor Department taxonomy (the values
// stored in metric_catalog.department: "ecommerce", "live_ops", …). The org's
// departments and the metrics taxonomy are different sets, so this NAME-based
// bridge is the ONLY correct link — never compare a users.department_id (uuid)
// against metric_catalog.department (text). Departments with no metrics slice
// (Business Development, HR & Admin) return null. Kept here (client-safe, pure
// string) so both server routes and the mobile wizard share one mapping.
export function metricsDepartmentForName(name: string | null | undefined): Department | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (n.includes("commerce") || n.includes("ecom") || n.includes("e-com")) return "ecommerce";
  if (n.includes("live")) return "live_ops";
  if (n.includes("warehouse") || n.includes("fulfill")) return "warehouse";
  if (n.includes("creative")) return "creatives";
  if (n.includes("affiliate")) return "affiliate";
  return null;
}

export const CATEGORY_LABELS: Record<string, string> = {
  sales: "Sales",
  traffic: "Traffic",
  customer: "Customer",
  operational: "Operational",
  account_health: "Account Health",
};

// Order categories render in on a dashboard.
export const CATEGORY_ORDER = [
  "sales",
  "traffic",
  "customer",
  "operational",
  "account_health",
] as const;

export type Lane = "auto" | "auto_possible" | "manual";
export type Unit = "currency" | "count" | "percent" | "hours" | "rating" | null;
export type Origin = "manual" | "api" | "reconciled" | "calculated";
export type ValidationStatus = "unvalidated" | "match" | "mismatch" | "overridden";
export type HealthDot = "green" | "amber" | "red" | null;

export interface CatalogMetric {
  metric_key: string;
  department: string;
  category: string | null;
  label: string;
  unit: Unit;
  lane: Lane;
  api_source: string | null;
  api_field: string | null;
  formula: string | null;
  direction: "up" | "down";
  sort_order: number;
  is_active: boolean;
}

// A metric resolved for a specific brand + period: the catalog definition, the
// separate manual / api values, the displayed value with its origin, the health
// dot from metric_targets, and (when compare is on) the previous-period value.
export interface DashboardMetric extends CatalogMetric {
  entry_id: string | null;
  manual_value: number | null;
  api_value: number | null;
  // The number the card shows and where it came from. null value => render "—".
  display_value: number | null;
  display_origin: Origin | null;
  variance_pct: number | null;
  validation_status: ValidationStatus;
  entered_by: string | null;
  entered_by_name: string | null;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string | null;
  note: string | null;
  // From metric_targets (thresholds live there, not here).
  health: HealthDot;
  target_value: number | null;
  // Compare mode: the display value from the comparison period, and its delta %.
  compare_value: number | null;
  delta_pct: number | null;
}
