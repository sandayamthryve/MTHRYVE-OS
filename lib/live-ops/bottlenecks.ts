// lib/live-ops/bottlenecks.ts — the Live Operations bottleneck taxonomy.
//
// The category list mirrors the CHECK constraint on public.live_bottlenecks
// exactly (migration 0026), so the encode form, the dashboard filters and the
// DB can never disagree. Each category also carries the department that most
// naturally owns its fix, used to pre-fill the assignment routing.

export const BOTTLENECK_CATEGORIES = [
  "inventory_shortage",
  "product_availability",
  "voucher",
  "pricing",
  "technical",
  "connectivity",
  "av",
  "platform_error",
  "customer_complaint",
  "anchor_performance",
  "moderator_performance",
  "delivery",
] as const;

export type BottleneckCategory = (typeof BOTTLENECK_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<BottleneckCategory, string> = {
  inventory_shortage: "Inventory shortage",
  product_availability: "Product availability",
  voucher: "Voucher / promo",
  pricing: "Pricing",
  technical: "Technical",
  connectivity: "Connectivity",
  av: "Audio / video",
  platform_error: "Platform error",
  customer_complaint: "Customer complaint",
  anchor_performance: "Anchor performance",
  moderator_performance: "Moderator performance",
  delivery: "Delivery / logistics",
};

// The department that most naturally owns each category's fix. Free text to
// match users.team_assignment / the routing dropdown; leadership can re-route.
export const CATEGORY_DEPARTMENT: Record<BottleneckCategory, string> = {
  inventory_shortage: "Warehouse",
  product_availability: "Warehouse",
  voucher: "E-Commerce",
  pricing: "E-Commerce",
  technical: "Live Operations",
  connectivity: "Live Operations",
  av: "Live Operations",
  platform_error: "E-Commerce",
  customer_complaint: "Customer Service",
  anchor_performance: "Live Operations",
  moderator_performance: "Live Operations",
  delivery: "Warehouse",
};

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

// Badge tone per severity (matches components/ui Badge tones).
export const SEVERITY_TONE: Record<Severity, "teal" | "amber" | "red" | "violet" | "muted"> = {
  low: "muted",
  medium: "violet",
  high: "amber",
  critical: "red",
};

export const BOTTLENECK_STATUSES = ["open", "assigned", "in_progress", "resolved", "dismissed"] as const;
export type BottleneckStatus = (typeof BOTTLENECK_STATUSES)[number];

export const STATUS_LABEL: Record<BottleneckStatus, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export const STATUS_TONE: Record<BottleneckStatus, "teal" | "amber" | "red" | "violet" | "muted"> = {
  open: "red",
  assigned: "amber",
  in_progress: "violet",
  resolved: "teal",
  dismissed: "muted",
};

export function isBottleneckCategory(v: unknown): v is BottleneckCategory {
  return typeof v === "string" && (BOTTLENECK_CATEGORIES as readonly string[]).includes(v);
}

// The stored row shape (public.live_bottlenecks).
export interface LiveBottleneck {
  id: string;
  org_id: string;
  session_id: string;
  brand_id: string | null;
  category: BottleneckCategory;
  note: string | null;
  severity: Severity;
  status: BottleneckStatus;
  assigned_dept: string | null;
  assigned_to: string | null;
  task_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Consolidate a set of bottlenecks into per-category counts for the dashboard.
export interface CategoryRollup {
  category: BottleneckCategory;
  total: number;
  open: number;
  critical: number;
}

export function rollupByCategory(rows: LiveBottleneck[]): CategoryRollup[] {
  const map = new Map<BottleneckCategory, CategoryRollup>();
  for (const r of rows) {
    const cur =
      map.get(r.category) ?? { category: r.category, total: 0, open: 0, critical: 0 };
    cur.total += 1;
    if (r.status === "open" || r.status === "assigned" || r.status === "in_progress") cur.open += 1;
    if (r.severity === "critical") cur.critical += 1;
    map.set(r.category, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}
