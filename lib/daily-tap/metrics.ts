// lib/daily-tap/metrics.ts — the READ half of the Daily Tap, org-scoped.
//
// The tap is built by the automation endpoint on the SERVICE-ROLE client (GitHub Actions
// has no user session), so RLS is bypassed and every read here MUST filter by
// org_id explicitly — otherwise a metric_entries / metric_targets read would
// span tenants. This is the one difference from lib/cognition/scope.ts, which
// leans on the caller's RLS client for org scoping; everything else (the field
// flattening, the latest-entry-per-key reduction, the manual-floor actual, the
// deterministic health dot) mirrors that reader so the tap and the Cognition
// Loop grade a metric identically.
//
// Nothing here writes, and nothing is invented: a key with no entry reads null
// (value == null, hasEntry false) so the builder can say "log today's numbers"
// rather than a fabricated figure.

import { healthFor, HEALTH_LABEL, type TargetRow } from "@/lib/metrics/health";
import { EMPTY } from "@/lib/metrics/format";
import type { HealthDot } from "@/lib/metrics/types";

type Shim = { from: (t: string) => any };

interface CompartmentField {
  key: string;
  label?: string;
  unit?: string;
}
interface CompartmentRow {
  code: string;
  label: string;
  department: string | null;
  fields: CompartmentField[] | null;
}
interface EntryRow {
  metric_key: string;
  period_start: string;
  period_end: string;
  manual_value: number | string | null;
  api_value: number | string | null;
  updated_at: string;
}
interface TargetRowFull {
  metric: string;
  target_value: number | string | null;
  direction: string | null;
  green_min: number | string | null;
  amber_min: number | string | null;
  band_low: number | string | null;
  band_high: number | string | null;
}

// One graded reading for the tap — real rows only.
export interface TapReading {
  key: string;
  label: string;
  unit: string;
  value: number | null; // actual (manual floor, else api), null when no entry
  hasEntry: boolean;
  target: number | null;
  dot: HealthDot; // deterministic verdict, null when ungradeable
  valueText: string; // formatted actual or "—"
  targetText: string | null; // formatted target or null
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The displayed actual: manual floor wins, else API, else null (honest empty).
function actual(entry: EntryRow | undefined): number | null {
  if (!entry) return null;
  const manual = num(entry.manual_value);
  if (manual != null) return manual;
  return num(entry.api_value);
}

// A short unit-aware value string ("4.55%", "2.2 / 5", "3h", "12").
export function fmtValue(value: number | null, unit: string): string {
  if (value == null) return EMPTY;
  switch (unit) {
    case "percent":
      return `${value}%`;
    case "rating":
      return `${value} / 5`;
    case "hours":
      return `${value}h`;
    default:
      return `${value}`;
  }
}

// Normalize a department / compartment name to a comparable token: lowercase,
// letters+digits only. Lets "Creative" match the "Creative Studio" compartment
// and "E-Commerce Ops" match exactly, while "Warehouse & Fulfillment" (which has
// no compartment yet) correctly matches nothing → honest empty scope.
function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Every compartment (code, label, department, fields). Compartments are global
// reference rows (not org-scoped), so no org filter — the org scoping happens on
// the entries/targets read below.
async function readCompartments(db: Shim): Promise<CompartmentRow[]> {
  const { data } = await db
    .from("metric_compartments")
    .select("code, label, department, fields")
    .order("sort_order", { ascending: true });
  return ((data ?? []) as CompartmentRow[]).filter((c) => c?.code);
}

// The compartment codes whose department text matches a given org department
// name (bidirectional normalized-substring match). Returns [] when the
// department has no metrics compartment — the builder then falls back to the
// honest "log today's numbers" nudge.
export async function compartmentCodesForDepartment(
  db: Shim,
  deptName: string | null | undefined
): Promise<{ codes: string[]; label: string | null }> {
  const target = norm(deptName);
  if (!target) return { codes: [], label: null };
  const comps = await readCompartments(db);
  const matched = comps.filter((c) => {
    const d = norm(c.department);
    return d.length > 0 && (d === target || d.includes(target) || target.includes(d));
  });
  return {
    codes: matched.map((c) => c.code),
    label: matched[0]?.department ?? null,
  };
}

// All compartment codes — the org-wide scope for the leadership Operating Score.
export async function allCompartmentCodes(db: Shim): Promise<string[]> {
  const comps = await readCompartments(db);
  return comps.map((c) => c.code);
}

// Grade a set of compartments for one org: flatten their fields, pull the latest
// org-scoped entry per key, join targets, and resolve a deterministic dot. Order
// follows the compartments' sort order; a key appears once (first compartment
// wins). Never throws — a failed read yields [].
export async function readOrgReadings(
  db: Shim,
  orgId: string,
  codes: string[]
): Promise<TapReading[]> {
  if (codes.length === 0) return [];
  try {
    const { data: comps } = await db
      .from("metric_compartments")
      .select("code, label, department, fields")
      .in("code", codes);

    const ordered = ((comps ?? []) as CompartmentRow[])
      .slice()
      .sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code));

    const fields: { key: string; label: string; unit: string }[] = [];
    const seen = new Set<string>();
    for (const c of ordered) {
      for (const f of c.fields ?? []) {
        if (!f?.key || seen.has(f.key)) continue;
        seen.add(f.key);
        fields.push({ key: f.key, label: f.label ?? f.key, unit: f.unit ?? "count" });
      }
    }
    const keys = fields.map((f) => f.key);
    if (keys.length === 0) return [];

    // Org-scoped — the service-role client has no RLS, so org_id is the gate.
    const [entriesRes, targetsRes] = await Promise.all([
      db
        .from("metric_entries")
        .select("metric_key, period_start, period_end, manual_value, api_value, updated_at")
        .eq("org_id", orgId)
        // AI-spine guardrail: exclude soft-archived entries. This copy runs on
        // the service-role client (no RLS), so the exclusion MUST be explicit —
        // an RLS policy would never cover it.
        .is("archived_at", null)
        .in("metric_key", keys),
      db
        .from("metric_targets")
        .select("metric, target_value, direction, green_min, amber_min, band_low, band_high")
        .eq("org_id", orgId)
        .in("metric", keys),
    ]);

    // Latest entry per key: newest period_end wins, tie-broken by updated_at.
    const latest = new Map<string, EntryRow>();
    for (const e of (entriesRes.data ?? []) as EntryRow[]) {
      const cur = latest.get(e.metric_key);
      if (
        !cur ||
        e.period_end > cur.period_end ||
        (e.period_end === cur.period_end && (e.updated_at ?? "") > (cur.updated_at ?? ""))
      ) {
        latest.set(e.metric_key, e);
      }
    }
    const targets = new Map<string, TargetRowFull>();
    for (const t of (targetsRes.data ?? []) as TargetRowFull[]) {
      if (!targets.has(t.metric)) targets.set(t.metric, t);
    }

    return fields.map((f) => {
      const value = actual(latest.get(f.key));
      const t = targets.get(f.key);
      const target = num(t?.target_value);
      const targetRow: TargetRow | undefined = t
        ? {
            metric: f.key,
            green_min: num(t.green_min),
            amber_min: num(t.amber_min),
            band_low: num(t.band_low),
            band_high: num(t.band_high),
            direction: t.direction,
            target_value: target,
          }
        : undefined;
      const dot = healthFor(value, targetRow);
      return {
        key: f.key,
        label: f.label,
        unit: f.unit,
        value,
        hasEntry: value != null,
        target,
        dot,
        valueText: fmtValue(value, f.unit),
        targetText: target != null ? fmtValue(target, f.unit) : null,
      };
    });
  } catch {
    return [];
  }
}

// The verdict word for a dot, or null when ungraded.
export function verdictWord(dot: HealthDot): string | null {
  return dot ? HEALTH_LABEL[dot].toLowerCase() : null;
}

// An Operating Score in [0,100] over the GRADED readings only (green=100,
// amber=60, red=0), plus how many were graded. Null when nothing is graded —
// honest "no score yet" rather than a fabricated 100.
export function operatingScore(readings: TapReading[]): { value: number | null; graded: number } {
  const graded = readings.filter((r) => r.dot != null);
  if (graded.length === 0) return { value: null, graded: 0 };
  const pts = graded.reduce((sum, r) => sum + (r.dot === "green" ? 100 : r.dot === "amber" ? 60 : 0), 0);
  return { value: Math.round(pts / graded.length), graded: graded.length };
}
