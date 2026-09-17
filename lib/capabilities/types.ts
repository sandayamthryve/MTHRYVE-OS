// lib/capabilities/types.ts — the Vesper Core capability registry model.
//
// public.capabilities is the org's map of what the OS can actually do, across 16
// intelligence domains and ~300 capabilities. It is provisioned + seeded out of
// band (like skill_registry / automation_registry / action_requests), so it isn't
// in the generated Database types — every reader/writer reaches it through the
// app's cast shim on the caller's RLS client.
//
// This module is CLIENT-SAFE: types + pure display/coverage helpers only. No
// Supabase, no server imports — so both the server page and the client registry
// components share one source of truth for status colors and coverage math.

// The four coverage states a capability can be in. Ordered by how "real" they
// are: live (available now) → partial (works, but not fully) → planned (roadmap)
// → vendor (only via a third-party tool we don't own yet).
export const CAPABILITY_STATUSES = ["live", "partial", "planned", "vendor"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export function isCapabilityStatus(v: unknown): v is CapabilityStatus {
  return typeof v === "string" && (CAPABILITY_STATUSES as readonly string[]).includes(v);
}

// The reference arrays a capability carries. All are jsonb string[] in the DB;
// required_skills maps to skill_registry keys and required_workflows to
// automation_registry keys (the rest are free-text descriptors).
export interface Capability {
  id: string;
  domain_no: number;
  domain: string;
  name: string;
  status: CapabilityStatus;
  required_skills: string[];
  required_tools: string[];
  required_knowledge: string[];
  required_agents: string[];
  required_workflows: string[];
  required_permissions: string[];
  kpis: string[];
  outputs: string[];
  notes: string | null;
}

// The editable reference fields, keyed for the leadership edit form + the update
// action. Kept as one list so the form, the action's allow-list and the picker
// wiring never drift.
export const CAPABILITY_REF_FIELDS = [
  "required_skills",
  "required_tools",
  "required_knowledge",
  "required_agents",
  "required_workflows",
  "required_permissions",
  "kpis",
  "outputs",
] as const;
export type CapabilityRefField = (typeof CAPABILITY_REF_FIELDS)[number];

export const CAPABILITY_REF_LABELS: Record<CapabilityRefField, string> = {
  required_skills: "Skills",
  required_tools: "Tools",
  required_knowledge: "Knowledge",
  required_agents: "Agents",
  required_workflows: "Workflows",
  required_permissions: "Permissions",
  kpis: "KPIs",
  outputs: "Outputs",
};

// ── Status display (mirrors MThryve_Capability_Coverage_Map.html) ──────────────
// live = green, partial = amber, planned = grey, vendor = violet. One place so
// chips, the legend and the filters all agree.
export interface StatusMeta {
  label: string;
  /** Full chip classes (border + bg + text) for a status pill. */
  chip: string;
  /** Solid fill for the coverage bar segment / dot. */
  fill: string;
  /** A short one-liner for tooltips / the legend. */
  blurb: string;
}

export const STATUS_META: Record<CapabilityStatus, StatusMeta> = {
  live: {
    label: "Live",
    chip: "border-green-500/40 bg-green-500/15 text-green-400",
    fill: "bg-green-500",
    blurb: "Available now.",
  },
  partial: {
    label: "Partial",
    chip: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    fill: "bg-amber-500",
    blurb: "Works, but not fully built out.",
  },
  planned: {
    label: "Planned",
    chip: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
    fill: "bg-charcoal-700",
    blurb: "On the roadmap — not yet available.",
  },
  vendor: {
    label: "Vendor",
    chip: "border-violet-500/40 bg-violet-500/15 text-violet-300",
    fill: "bg-violet-500",
    blurb: "Only via a third-party tool we don't own yet.",
  },
};

// Coverage weight per status: live counts fully, partial counts half, planned and
// vendor count as zero (nothing we can execute on today).
export function statusWeight(status: CapabilityStatus): number {
  if (status === "live") return 1;
  if (status === "partial") return 0.5;
  return 0;
}

// Only live + partial capabilities can be turned into mission tasks — there's
// something real to execute. Planned/vendor have nothing to run yet.
export function canRunMission(status: CapabilityStatus): boolean {
  return status === "live" || status === "partial";
}

export interface Coverage {
  total: number;
  counts: Record<CapabilityStatus, number>;
  /** Weighted coverage as a 0–100 percentage (live=1, partial=0.5). */
  percent: number;
  /** Sum of weights (for aggregation across domains). */
  weight: number;
}

// Weighted coverage over a set of capabilities. Returns per-status counts and the
// 0–100 percentage the bars + headline score render from.
export function computeCoverage(caps: Pick<Capability, "status">[]): Coverage {
  const counts: Record<CapabilityStatus, number> = { live: 0, partial: 0, planned: 0, vendor: 0 };
  let weight = 0;
  for (const c of caps) {
    counts[c.status] = (counts[c.status] ?? 0) + 1;
    weight += statusWeight(c.status);
  }
  const total = caps.length;
  const percent = total > 0 ? Math.round((weight / total) * 1000) / 10 : 0;
  return { total, counts, percent, weight };
}

// A domain group with its own coverage, used for the grouped registry view.
export interface DomainGroup {
  domain_no: number;
  domain: string;
  capabilities: Capability[];
  coverage: Coverage;
}

// Group capabilities by domain_no (ascending), each with its own coverage. The
// input is assumed org-scoped already (RLS did that); this is pure shaping.
export function groupByDomain(caps: Capability[]): DomainGroup[] {
  const byNo = new Map<number, Capability[]>();
  for (const c of caps) {
    const list = byNo.get(c.domain_no) ?? [];
    list.push(c);
    byNo.set(c.domain_no, list);
  }
  return Array.from(byNo.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([domain_no, list]) => ({
      domain_no,
      domain: list[0]?.domain ?? `Domain ${domain_no}`,
      capabilities: [...list].sort((a, b) => a.name.localeCompare(b.name)),
      coverage: computeCoverage(list),
    }));
}
