// lib/automation-radar/data.ts — RLS-scoped reads for the Automation Radar surface.
//
// Every read runs on the CALLER'S @supabase/ssr client, so Postgres RLS is the
// hard wall: repetition_patterns_org_read scopes rows to the caller's org, and the
// department filter here narrows to one team's slice for the per-department panel.
// repetition_patterns isn't in the generated Database types, so — like the rest of
// the OS's newer tables — it's reached through the app's cast shim.

import {
  isAutomatability,
  isPatternStatus,
  type RepetitionPattern,
} from "@/lib/automation-radar/types";

type Shim = { from: (t: string) => any };

const PATTERN_COLUMNS =
  "id, pattern_key, normalized_title, sample_titles, department, assignee_id, occurrences, first_seen, last_seen, cadence, avg_interval_days, est_minutes_each, time_cost_per_month, automatability, suggested_path, matched_capability_id, matched_workflow, status";

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function normalize(row: Record<string, unknown>): RepetitionPattern {
  return {
    id: String(row.id),
    pattern_key: String(row.pattern_key ?? ""),
    normalized_title: String(row.normalized_title ?? ""),
    sample_titles: strArray(row.sample_titles),
    department: row.department == null ? null : String(row.department),
    assignee_id: row.assignee_id == null ? null : String(row.assignee_id),
    occurrences: Number(row.occurrences ?? 0),
    first_seen: row.first_seen == null ? null : String(row.first_seen),
    last_seen: row.last_seen == null ? null : String(row.last_seen),
    cadence: row.cadence == null ? null : String(row.cadence),
    avg_interval_days: row.avg_interval_days == null ? null : Number(row.avg_interval_days),
    est_minutes_each: row.est_minutes_each == null ? null : Number(row.est_minutes_each),
    time_cost_per_month: row.time_cost_per_month == null ? null : Number(row.time_cost_per_month),
    automatability: isAutomatability(row.automatability) ? row.automatability : null,
    suggested_path: row.suggested_path == null ? null : String(row.suggested_path),
    matched_capability_id: row.matched_capability_id == null ? null : String(row.matched_capability_id),
    matched_workflow: row.matched_workflow == null ? null : String(row.matched_workflow),
    status: isPatternStatus(row.status) ? row.status : "detected",
  };
}

export interface ListPatternsOptions {
  /** Filter to one department's slice (the per-department panel). null = all. */
  department?: string | null;
  /** Include dismissed patterns (default: hidden). */
  includeDismissed?: boolean;
  limit?: number;
}

// All patterns the caller can see (RLS org-scoped), optionally filtered to one
// department, ranked by monthly time cost (biggest wins first). Returns [] on any
// read error so the surface renders empty instead of 500-ing.
export async function listPatterns(
  db: Shim,
  opts: ListPatternsOptions = {}
): Promise<RepetitionPattern[]> {
  let q = db
    .from("repetition_patterns")
    .select(PATTERN_COLUMNS)
    .order("time_cost_per_month", { ascending: false, nullsFirst: false });
  if (opts.department) q = q.eq("department", opts.department);
  if (!opts.includeDismissed) q = q.neq("status", "dismissed");
  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) return [];
  return ((data ?? []) as Record<string, unknown>[]).map(normalize);
}

// One pattern by id, or null if absent / not visible under RLS.
export async function getPatternById(db: Shim, id: string): Promise<RepetitionPattern | null> {
  if (!id) return null;
  const { data } = await db.from("repetition_patterns").select(PATTERN_COLUMNS).eq("id", id).maybeSingle();
  return data ? normalize(data as Record<string, unknown>) : null;
}

// Resolve matched capability ids → display names (RLS-scoped). Used by the surface
// to show the real capability name next to an 'automatable' pattern.
export async function capabilityNames(db: Shim, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data } = await db.from("capabilities").select("id, name").in("id", unique);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) {
    if (row.name) map.set(String(row.id), row.name);
  }
  return map;
}

// Resolve assignee ids → full names (RLS-scoped), for the "who" column.
export async function assigneeNames(db: Shim, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const { data } = await db.from("users").select("id, full_name").in("id", unique);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
    if (row.full_name) map.set(String(row.id), row.full_name);
  }
  return map;
}
