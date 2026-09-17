// lib/cognition/scope.ts — the READ half of the Cognition Loop.
//
// Given one (or more) compartment codes, this reads the compartment's field
// metric_keys from metric_compartments, pulls the LATEST metric_entries row per
// key, joins each key's metric_targets goalposts, and computes a deterministic
// actual-vs-target status. It GROUNDS ONLY IN REAL ROWS: a metric with no entry
// reads "—" (value null, hasEntry false) and is never invented downstream. It is
// read-only and writes nothing.
//
// The default scope is compartment T8 (Shop Health / Compliance) plus the store
// rating composite T9 (its pillar keys) — the task's starting scope.

import { healthFor, HEALTH_LABEL, type TargetRow } from "@/lib/metrics/health";
import { EMPTY } from "@/lib/metrics/format";
import type { CompartmentScope, MetricReading } from "./types";

// The default Cognition Loop scope: Shop Health (T8) + the Store Rating pillars
// (T9). Callers may pass their own compartment codes to widen/narrow it.
export const DEFAULT_COMPARTMENT_CODES = ["T8", "T9"];

type Shim = { from: (t: string) => any };

// The compartment field shape (metric_compartments.fields jsonb).
interface CompartmentField {
  key: string;
  label?: string;
  unit?: string;
}
interface CompartmentRow {
  code: string;
  platform: string;
  label: string;
  fields: CompartmentField[] | null;
}

// The metric_entries columns we need to resolve the latest actual per key.
interface EntryRow {
  metric_key: string;
  marketplace: string | null;
  period_start: string;
  period_end: string;
  manual_value: number | string | null;
  api_value: number | string | null;
  updated_at: string;
}

// The metric_targets columns we need (the goalposts).
interface TargetRowFull {
  metric: string;
  target_value: number | string | null;
  direction: string | null;
  green_min: number | string | null;
  amber_min: number | string | null;
  band_low: number | string | null;
  band_high: number | string | null;
  notes: string | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The displayed actual: the manual floor wins when present, else the API value,
// else null (honest empty) — mirrors lib/metrics/data.ts `display`.
function actual(entry: EntryRow | undefined): { value: number | null; origin: "manual" | "api" | null } {
  if (!entry) return { value: null, origin: null };
  const manual = num(entry.manual_value);
  if (manual != null) return { value: manual, origin: "manual" };
  const api = num(entry.api_value);
  if (api != null) return { value: api, origin: "api" };
  return { value: null, origin: null };
}

// A short unit suffix for prose ("4.55%", "2.2 / 5", "3 pts").
function fmt(value: number | null, unit: string): string {
  if (value == null) return EMPTY;
  switch (unit) {
    case "percent":
      return `${value}%`;
    case "rating":
      return `${value} / 5`;
    case "hours":
      return `${value}h`;
    case "count":
      return `${value}`;
    default:
      return `${value}`;
  }
}

// The deterministic status phrase for one reading — real numbers only. When the
// value is missing it says so; when a dot resolves it uses the app's own verdict
// vocabulary; otherwise it states the raw actual-vs-target gap without a verdict.
function statusPhrase(
  value: number | null,
  unit: string,
  target: number | null,
  direction: string | null,
  dot: MetricReading["dot"]
): string {
  if (value == null) return "No entry on record — reads —.";
  const a = fmt(value, unit);
  if (target == null) return `${a}; no target set.`;
  const t = fmt(target, unit);
  const verdict = dot ? HEALTH_LABEL[dot] : null;
  if (verdict) return `${a} vs target ${t} — ${verdict}.`;
  // No band thresholds → state the direction-aware gap honestly, no verdict.
  if (direction === "lower_better") {
    return value <= target ? `${a} vs ceiling ${t} — within target.` : `${a} vs ceiling ${t} — over target.`;
  }
  return value >= target ? `${a} vs target ${t} — at/above target.` : `${a} vs target ${t} — below target.`;
}

// Read one compartment scope. Compartments are global (RLS-readable by any
// authenticated user); metric_entries / metric_targets are org-scoped by RLS on
// the caller's client, so no explicit org filter is needed here.
export async function readCompartmentScope(
  db: Shim,
  codes: string[] = DEFAULT_COMPARTMENT_CODES
): Promise<CompartmentScope> {
  const { data: comps } = await db
    .from("metric_compartments")
    .select("code, platform, label, fields")
    .in("code", codes);

  const compartments = ((comps ?? []) as CompartmentRow[]).slice().sort((a, b) =>
    codes.indexOf(a.code) - codes.indexOf(b.code)
  );

  // Flatten the fields into ordered (key,label,unit) triples, de-duplicated by
  // key (a computed key can appear once). Skip malformed fields defensively.
  const fields: { key: string; label: string; unit: string; platform: string }[] = [];
  const seen = new Set<string>();
  for (const c of compartments) {
    for (const f of c.fields ?? []) {
      if (!f?.key || seen.has(f.key)) continue;
      seen.add(f.key);
      fields.push({
        key: f.key,
        label: f.label ?? f.key,
        unit: f.unit ?? "count",
        platform: c.platform,
      });
    }
  }

  const keys = fields.map((f) => f.key);
  if (keys.length === 0) {
    return {
      codes,
      label: compartments.map((c) => `${c.code} · ${c.label}`).join("  +  ") || codes.join(", "),
      platform: null,
      readings: [],
      grounded: 0,
    };
  }

  // Latest entry per key + all targets for the keys, in parallel.
  const [entriesRes, targetsRes] = await Promise.all([
    db
      .from("metric_entries")
      .select("metric_key, marketplace, period_start, period_end, manual_value, api_value, updated_at")
      // AI-spine guardrail: archived entries MUST NOT feed reasoning. This read
      // is the shared chokepoint for the Cognition Loop AND the Executive
      // Council (both call readCompartmentScope), so the filter here protects the
      // whole reasoning surface — a soft-archived metric silently drops out.
      .is("archived_at", null)
      .in("metric_key", keys),
    db
      .from("metric_targets")
      .select("metric, target_value, direction, green_min, amber_min, band_low, band_high, notes")
      .in("metric", keys),
  ]);

  // Reduce to the LATEST entry per key: newest period_end wins, tie-broken by
  // most-recent updated_at. Nothing is invented — a key with no rows stays absent.
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

  const readings: MetricReading[] = fields.map((f) => {
    const entry = latest.get(f.key);
    const { value, origin } = actual(entry);
    const t = targets.get(f.key);
    const target = num(t?.target_value);
    const direction = (t?.direction as MetricReading["direction"]) ?? null;
    const greenMin = num(t?.green_min);
    const amberMin = num(t?.amber_min);
    const bandLow = num(t?.band_low);
    const bandHigh = num(t?.band_high);

    const targetRow: TargetRow | undefined = t
      ? {
          metric: f.key,
          green_min: greenMin,
          amber_min: amberMin,
          band_low: bandLow,
          band_high: bandHigh,
          direction,
          target_value: target,
        }
      : undefined;
    const dot = healthFor(value, targetRow);

    return {
      key: f.key,
      label: f.label,
      unit: f.unit,
      value,
      origin,
      hasEntry: value != null,
      period: entry ? `${entry.period_start} → ${entry.period_end}` : null,
      marketplace: entry?.marketplace ?? null,
      target,
      direction,
      greenMin,
      amberMin,
      bandLow,
      bandHigh,
      notes: t?.notes ?? null,
      hasTarget: !!t,
      dot,
      status: statusPhrase(value, f.unit, target, direction, dot),
    };
  });

  const platforms = Array.from(new Set(fields.map((f) => f.platform)));

  return {
    codes,
    label: compartments.map((c) => `${c.code} · ${c.label}`).join("  +  ") || codes.join(", "),
    platform: platforms.length === 1 ? platforms[0] : null,
    readings,
    grounded: readings.filter((r) => r.hasEntry).length,
  };
}
