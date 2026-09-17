// lib/metrics/review.ts — the GROUNDING layer for the AI Account Review Brief.
//
// This module turns the org's real, populated metric rows into a normalized set
// of MetricEntry facts the brief is built from. It is the single guard against
// fabrication: every value here comes from an actual row in metrics_snapshots,
// brand_platform_metrics, or metric_targets — and when a metric has NO row for
// the selected scope/period, its value is `null` (reported downstream as
// "no data", never as 0). Nothing in this file calls a model; it is pure, honest
// arithmetic over what exists.
//
// Scope: a department (by name → id) + optional brand + a [period_start,
// period_end] window. Universal operational metrics (efficiency, quality,
// capacity, GMV impact) come from the latest overlapping metrics_snapshots row;
// per-brand commerce metrics come from the live tiktok_shop_performance summed over the
// window; targets/bands come from metric_targets. Health and variance are judged
// ONLY where both a real value and a real target exist.

// These tables aren't in the generated Database types, so — as elsewhere in the
// codebase (Actions, Live, Contracts) — we read them through a small cast shim.
type Shim = { from: (t: string) => any };

// ── Public shapes ─────────────────────────────────────────────────────────────

export type MetricHealth = "good" | "watch" | "risk" | "none";
export type ValidationStatus = "validated" | "unvalidated" | "no_data";
export type MetricDirection = "higher_better" | "lower_better" | "band";

export interface MetricEntry {
  key: string;
  label: string;
  unit: "%" | "PHP" | "count" | "x" | "ratio";
  origin: string; // the source table/row the value was read from
  value: number | null; // null ⇒ no real row for this metric in scope (honest gap)
  target: number | null; // null ⇒ no target on record for this metric
  direction: MetricDirection;
  variance: number | null; // value − target (signed), or null when either is missing
  variance_pct: number | null; // variance as a fraction of target, or null
  health: MetricHealth; // 'none' when it can't be judged (no value or no target)
  validation_status: ValidationStatus;
  note: string | null; // an honest, deterministic one-liner (never model-authored)
}

export interface HealthRollup {
  good: number;
  watch: number;
  risk: number;
  none: number;
  scored: number; // good + watch + risk (metrics with a value AND a target)
  score: number | null; // 0–100 weighted health, or null when nothing is scorable
  label: string;
}

export interface ReviewScope {
  department: string; // display name, or "Organization" for org-level
  department_id: string | null; // null ⇒ org-level (department_id is null snapshots)
  brand_id: string | null;
  brand_name: string | null;
  period_start: string;
  period_end: string;
}

export interface ReviewData {
  scope: ReviewScope;
  entries: MetricEntry[];
  rollup: HealthRollup;
  mismatch_flags: string[]; // provenance / target-coverage warnings, evidence-linked
  hasData: boolean; // true when at least one metric has a real value
  narrative: {
    ongoing_tasks: string | null;
    expected_outputs: string | null;
    challenges: string | null;
    action_plan: string | null;
  };
}

export interface ReviewInput {
  department: string;
  department_id?: string | null;
  brand_id?: string | null;
  period_start: string;
  period_end: string;
}

// ── Metric definitions ────────────────────────────────────────────────────────

interface SnapshotDef {
  key: "efficiency" | "quality_score" | "capacity_utilization" | "gmv_impact";
  label: string;
  unit: MetricEntry["unit"];
}

const SNAPSHOT_METRICS: SnapshotDef[] = [
  { key: "efficiency", label: "Operational Efficiency", unit: "%" },
  { key: "quality_score", label: "Quality Score", unit: "%" },
  { key: "capacity_utilization", label: "Capacity Utilization", unit: "%" },
  { key: "gmv_impact", label: "GMV Impact", unit: "PHP" },
];

interface BrandDef {
  key: string;
  label: string;
  unit: MetricEntry["unit"];
  direction: MetricDirection;
  // How to fold the per-platform rows into one figure for the window.
  agg: "sum" | "avg";
  read: (r: BrandMetricRow) => number | null;
}

interface BrandMetricRow {
  gmv: number | null;
  orders: number | null;
  units: number | null;
  returns: number | null;
  return_rate: number | null;
  fulfillment_errors: number | null;
  ad_spend: number | null;
  ad_revenue: number | null;
  roas: number | null;
  source: string | null;
}

const BRAND_METRICS: BrandDef[] = [
  // read returns the RAW nullable value (not num()) so a metric the live source
  // does not carry stays null → the fold below yields "no_data", an honest "—",
  // never a summed 0. GMV (channel = TikTok Shop today; Shopee/Lazada not connected).
  { key: "gmv", label: "GMV (brand · TikTok Shop)", unit: "PHP", direction: "higher_better", agg: "sum", read: (r) => r.gmv },
  { key: "orders", label: "Orders", unit: "count", direction: "higher_better", agg: "sum", read: (r) => r.orders },
  { key: "units", label: "Units sold", unit: "count", direction: "higher_better", agg: "sum", read: (r) => r.units },
  { key: "returns", label: "Returns", unit: "count", direction: "lower_better", agg: "sum", read: (r) => r.returns },
  { key: "fulfillment_errors", label: "Fulfillment errors", unit: "count", direction: "lower_better", agg: "sum", read: (r) => r.fulfillment_errors },
  { key: "ad_spend", label: "Ad spend", unit: "PHP", direction: "band", agg: "sum", read: (r) => r.ad_spend },
  { key: "ad_revenue", label: "Ad revenue", unit: "PHP", direction: "higher_better", agg: "sum", read: (r) => r.ad_revenue },
  { key: "roas", label: "ROAS (avg)", unit: "x", direction: "higher_better", agg: "avg", read: (r) => r.roas },
];

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Target rows ───────────────────────────────────────────────────────────────

interface TargetRow {
  metric: string;
  scope: string; // 'org' | 'department' | ...
  department_id: string | null;
  target_value: number | null;
  direction: MetricDirection;
  green_min: number | null;
  amber_min: number | null;
  band_low: number | null;
  band_high: number | null;
}

// Pick the most specific target for a metric: a department-scoped row for this
// department beats an org-scoped row. Returns null when none is on record.
function pickTarget(targets: TargetRow[], metric: string, departmentId: string | null): TargetRow | null {
  const forMetric = targets.filter((t) => t.metric === metric);
  if (departmentId) {
    const dept = forMetric.find((t) => t.scope === "department" && t.department_id === departmentId);
    if (dept) return dept;
  }
  return forMetric.find((t) => t.scope === "org") ?? forMetric[0] ?? null;
}

// ── Health judgement (deterministic) ──────────────────────────────────────────

function judge(value: number | null, t: TargetRow | null): { health: MetricHealth; variance: number | null; variance_pct: number | null } {
  if (value === null || !t) return { health: "none", variance: null, variance_pct: null };

  const dir = t.direction;
  if (dir === "band") {
    const low = t.band_low;
    const high = t.band_high;
    if (low === null || high === null) return { health: "none", variance: null, variance_pct: null };
    const mid = (low + high) / 2;
    const variance = value - mid;
    const variance_pct = mid !== 0 ? variance / mid : null;
    if (value >= low && value <= high) return { health: "good", variance, variance_pct };
    const span = (high - low) || 1;
    const outside = value < low ? low - value : value - high;
    return { health: outside <= span * 0.15 ? "watch" : "risk", variance, variance_pct };
  }

  // higher_better / lower_better share the same green/amber banding logic; for
  // lower_better we mirror the comparisons.
  const target = t.target_value;
  const green = t.green_min;
  const amber = t.amber_min;
  const variance = target !== null ? value - target : null;
  const variance_pct = target !== null && target !== 0 ? (value - target) / target : null;

  const cmp = (a: number, b: number) => (dir === "lower_better" ? a <= b : a >= b);

  if (green !== null && amber !== null) {
    if (cmp(value, green)) return { health: "good", variance, variance_pct };
    if (cmp(value, amber)) return { health: "watch", variance, variance_pct };
    return { health: "risk", variance, variance_pct };
  }
  if (target !== null) {
    if (cmp(value, target)) return { health: "good", variance, variance_pct };
    // within 15% of target → watch, else risk
    const watchThreshold = dir === "lower_better" ? target * 1.15 : target * 0.85;
    if (cmp(value, watchThreshold)) return { health: "watch", variance, variance_pct };
    return { health: "risk", variance, variance_pct };
  }
  return { health: "none", variance, variance_pct };
}

const HEALTH_WEIGHT: Record<Exclude<MetricHealth, "none">, number> = { good: 100, watch: 60, risk: 20 };

function rollup(entries: MetricEntry[]): HealthRollup {
  let good = 0, watch = 0, risk = 0, none = 0, sum = 0, scored = 0;
  for (const e of entries) {
    if (e.health === "good") { good++; sum += HEALTH_WEIGHT.good; scored++; }
    else if (e.health === "watch") { watch++; sum += HEALTH_WEIGHT.watch; scored++; }
    else if (e.health === "risk") { risk++; sum += HEALTH_WEIGHT.risk; scored++; }
    else none++;
  }
  const score = scored > 0 ? Math.round(sum / scored) : null;
  let label = "Insufficient data";
  if (score !== null) {
    if (score >= 85) label = "Healthy";
    else if (score >= 60) label = "Watch";
    else label = "At risk";
  }
  return { good, watch, risk, none, scored, score, label };
}

// ── Loader ────────────────────────────────────────────────────────────────────

// Rows overlap the window when they start on/before the window end AND end
// on/after the window start.
function overlapFilter(q: any, start: string, end: string) {
  return q.lte("period_start", end).gte("period_end", start);
}

export async function loadReviewData(db: Shim, input: ReviewInput): Promise<ReviewData> {
  const orgLevel = input.department_id == null;
  const scope: ReviewScope = {
    department: input.department,
    department_id: input.department_id ?? null,
    brand_id: input.brand_id ?? null,
    brand_name: null,
    period_start: input.period_start,
    period_end: input.period_end,
  };

  // Brand display name (if scoped to a brand).
  if (scope.brand_id) {
    const { data: b } = await db.from("brands").select("name").eq("id", scope.brand_id).maybeSingle();
    scope.brand_name = (b as { name?: string } | null)?.name ?? null;
  }

  // 1) Latest overlapping department snapshot (or org-level snapshot when no
  //    department is chosen). department_id is null for org-level rows.
  let snapQ = db
    .from("metrics_snapshots")
    .select("efficiency, quality_score, capacity_utilization, gmv_impact, ongoing_tasks, expected_outputs, challenges, action_plan, period_start, period_end")
    .order("period_end", { ascending: false })
    .limit(1);
  snapQ = orgLevel ? snapQ.is("department_id", null) : snapQ.eq("department_id", scope.department_id);
  snapQ = overlapFilter(snapQ, input.period_start, input.period_end);
  const { data: snapData } = await snapQ.maybeSingle();
  const snap = snapData as
    | (Record<SnapshotDef["key"], number | null> & {
        ongoing_tasks: string | null;
        expected_outputs: string | null;
        challenges: string | null;
        action_plan: string | null;
      })
    | null;

  // 2) Targets (org + department scoped) for the metric keys we judge against.
  const { data: targetData } = await db.from("metric_targets").select("metric, scope, department_id, target_value, direction, green_min, amber_min, band_low, band_high");
  const targets: TargetRow[] = ((targetData ?? []) as any[]).map((t) => ({
    metric: t.metric,
    scope: t.scope,
    department_id: t.department_id,
    target_value: num(t.target_value),
    direction: (t.direction as MetricDirection) ?? "higher_better",
    green_min: num(t.green_min),
    amber_min: num(t.amber_min),
    band_low: num(t.band_low),
    band_high: num(t.band_high),
  }));

  // 3) Per-brand commerce rows over the window (only when a brand is scoped), from
  //    the LIVE tiktok_shop_performance table — never the retired
  //    brand_platform_metrics. It carries commerce only (gmv / orders / units); the
  //    returns / fulfillment / ad columns it does not have stay NULL, so those
  //    review metrics report an honest "no_data" (see BRAND_METRICS.read below)
  //    rather than a fabricated 0. Summing the raw per-shop daily rows is correct
  //    here (the folds are all sum/avg over the window, no period collapse).
  let brandRows: BrandMetricRow[] = [];
  if (scope.brand_id) {
    const { data: bData } = await db
      .from("tiktok_shop_performance")
      .select("gmv, orders, units, source")
      .eq("brand_id", scope.brand_id)
      .gte("stat_date", input.period_start)
      .lte("stat_date", input.period_end);
    brandRows = ((bData ?? []) as any[]).map((r) => ({
      gmv: r.gmv == null ? null : num(r.gmv),
      orders: r.orders == null ? null : num(r.orders),
      units: r.units == null ? null : num(r.units),
      // Not carried by the live commerce source → null (honest "no_data").
      returns: null,
      return_rate: null,
      fulfillment_errors: null,
      ad_spend: null,
      ad_revenue: null,
      roas: null,
      source: r.source ?? "tiktok_api",
    }));
  }

  const entries: MetricEntry[] = [];

  // Universal operational metrics from the snapshot.
  for (const def of SNAPSHOT_METRICS) {
    const value = snap ? num(snap[def.key]) : null;
    const t = pickTarget(targets, def.key, scope.department_id);
    const j = judge(value, t);
    const validation: ValidationStatus = value === null ? "no_data" : "unvalidated";
    entries.push({
      key: def.key,
      label: def.label,
      unit: def.unit,
      origin: value === null ? "metrics_snapshots (no row in period)" : "metrics_snapshots",
      value,
      target: t ? (t.direction === "band" ? (t.band_low !== null && t.band_high !== null ? (t.band_low + t.band_high) / 2 : null) : t.target_value) : null,
      direction: t?.direction ?? "higher_better",
      variance: j.variance,
      variance_pct: j.variance_pct,
      health: j.health,
      validation_status: validation,
      note:
        value === null
          ? "No snapshot recorded for this scope in the selected period."
          : !t
          ? "No target on record — value shown, but not judged."
          : null,
    });
  }

  // Per-brand commerce/ad metrics (only when a brand is scoped).
  if (scope.brand_id) {
    const sources = Array.from(new Set(brandRows.map((r) => r.source).filter(Boolean))) as string[];
    for (const def of BRAND_METRICS) {
      const vals = brandRows.map(def.read).filter((v): v is number => v !== null);
      let value: number | null = null;
      if (vals.length > 0) value = def.agg === "avg" ? vals.reduce((a, b) => a + b, 0) / vals.length : vals.reduce((a, b) => a + b, 0);
      const t = pickTarget(targets, def.key, scope.department_id);
      const j = judge(value, t);
      const validation: ValidationStatus = value === null ? "no_data" : "unvalidated";
      entries.push({
        key: `brand_${def.key}`,
        label: def.label,
        unit: def.unit,
        origin: value === null ? "tiktok_shop_performance (no rows in period / not tracked)" : `tiktok_shop_performance${sources.length ? ` · ${sources.join("/")}` : ""}`,
        value,
        target: t ? t.target_value : null,
        direction: def.direction,
        variance: j.variance,
        variance_pct: j.variance_pct,
        health: t ? j.health : "none",
        validation_status: validation,
        note:
          value === null
            ? "No live TikTok Shop rows for this brand in the selected period (or not tracked in the live source)."
            : sources.length
            ? `Aggregated from ${brandRows.length} platform row(s) (source: ${sources.join(", ")}).`
            : null,
      });
    }
  }

  // Mismatch / provenance flags — evidence-linked, never speculative.
  const flags: string[] = [];
  const noData = entries.filter((e) => e.value === null);
  if (noData.length > 0) {
    flags.push(`${noData.length} of ${entries.length} metric(s) have no recorded value for this period: ${noData.map((e) => e.label).join(", ")}.`);
  }
  const valuedNoTarget = entries.filter((e) => e.value !== null && e.target === null && e.health === "none");
  if (valuedNoTarget.length > 0) {
    flags.push(`${valuedNoTarget.length} metric(s) have a value but no target to judge against: ${valuedNoTarget.map((e) => e.label).join(", ")}.`);
  }
  // A higher_better metric sitting at exactly 0 with a positive target is a
  // likely data gap masquerading as a real zero — surface it, don't hide it.
  const suspiciousZero = entries.filter(
    (e) => e.value === 0 && e.direction === "higher_better" && e.target !== null && e.target > 0
  );
  if (suspiciousZero.length > 0) {
    flags.push(`${suspiciousZero.length} metric(s) read exactly 0 against a positive target — verify these are real, not un-entered: ${suspiciousZero.map((e) => e.label).join(", ")}.`);
  }

  return {
    scope,
    entries,
    rollup: rollup(entries),
    mismatch_flags: flags,
    hasData: entries.some((e) => e.value !== null),
    narrative: {
      ongoing_tasks: snap?.ongoing_tasks ?? null,
      expected_outputs: snap?.expected_outputs ?? null,
      challenges: snap?.challenges ?? null,
      action_plan: snap?.action_plan ?? null,
    },
  };
}

// ── Display helpers (shared by UI + exports) ─────────────────────────────────

export const DASH = "—";

export function formatMetricValue(e: Pick<MetricEntry, "value" | "unit">): string {
  if (e.value === null) return DASH; // honest null — never 0
  const v = e.value;
  switch (e.unit) {
    case "PHP":
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(v);
      } catch {
        return `PHP ${Math.round(v)}`;
      }
    case "%":
      return `${round(v)}%`;
    case "ratio":
      return `${round(v * 100)}%`;
    case "x":
      return `${round(v)}×`;
    case "count":
      return new Intl.NumberFormat("en-US").format(Math.round(v));
    default:
      return String(v);
  }
}

export function formatTarget(e: Pick<MetricEntry, "target" | "unit" | "direction">): string {
  if (e.target === null) return DASH;
  return formatMetricValue({ value: e.target, unit: e.unit });
}

export function formatVariance(e: Pick<MetricEntry, "variance_pct" | "variance">): string {
  if (e.variance_pct !== null) {
    const p = Math.round(e.variance_pct * 100);
    return `${p >= 0 ? "+" : ""}${p}%`;
  }
  if (e.variance !== null) {
    const v = round(e.variance);
    return `${e.variance >= 0 ? "+" : ""}${v}`;
  }
  return DASH;
}

export const HEALTH_LABEL: Record<MetricHealth, string> = {
  good: "On track",
  watch: "Watch",
  risk: "At risk",
  none: "No data",
};

export const VALIDATION_LABEL: Record<ValidationStatus, string> = {
  validated: "Validated",
  unvalidated: "Recorded",
  no_data: "No data",
};

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
