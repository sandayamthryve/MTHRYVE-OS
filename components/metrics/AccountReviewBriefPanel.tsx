"use client";

// AccountReviewBriefPanel — the "AI Account Review Brief" surface for the Data
// Analytics (Metrics) page. A leader picks a scope (department + optional brand)
// and period, generates a GROUNDED brief (POST /api/metrics/brief → server-side
// Anthropic), and reads the structured result: a health rollup, the real metrics
// table with honest nulls, overall performance, highlights, concerns, and
// prioritized recommendations. Each recommendation has "Send to approval", which
// stages a PENDING action_request (POST …/recommend) — nothing executes. Past
// briefs re-open from the history list (GET /api/metrics/brief?id=).
//
// This component renders values only; it never computes or invents a metric —
// every number here comes back from the server's grounded loader.

import { useMemo, useState } from "react";

type NamedRow = { id: string; name: string };

type HistoryRow = {
  id: string;
  department: string;
  brand_id: string | null;
  period_start: string;
  period_end: string;
  summary: string | null;
  created_at: string;
};

type MetricEntry = {
  key: string;
  label: string;
  unit: string;
  origin: string;
  value: number | null;
  target: number | null;
  variance_pct: number | null;
  variance: number | null;
  health: "good" | "watch" | "risk" | "none";
  validation_status: "validated" | "unvalidated" | "no_data";
  note: string | null;
};

type Rollup = {
  good: number;
  watch: number;
  risk: number;
  none: number;
  scored: number;
  score: number | null;
  label: string;
};

type Recommendation = { action: string; rationale: string; priority: "high" | "medium" | "low"; target_department: string };

type ScenarioName = "best" | "base" | "worst";
type Scenario = {
  name: ScenarioName;
  premise: string;
  projected_outcome: string;
  drivers: string[];
  confidence: number;
  evidence_keys: string[];
};
type ScenarioMeta = {
  grounded: boolean;
  model: string | null;
  data_density: number;
  scored_metrics: number;
  low_data: boolean;
  note: string | null;
  generated_at: string;
};

type BriefPayload = {
  overall_performance: { sales_trend: string; traffic_trend: string; conversion_trend: string; operational_efficiency: string };
  highlights: string[];
  concerns: string[];
  recommendations: Recommendation[];
  scenarios?: Scenario[];
  scenario_meta?: ScenarioMeta;
  executive_summary: string;
  meta: { grounded: boolean; model: string | null; generated_at: string; metrics_with_data: number; metrics_total: number; note: string | null };
};

type BriefResult = {
  brief_id: string;
  created_at: string;
  scope: { department: string; brand_name: string | null; period_start: string; period_end: string };
  entries: MetricEntry[];
  rollup: Rollup | null;
  mismatch_flags: string[];
  payload: BriefPayload;
};

const DASH = "—";

const HEALTH_META: Record<MetricEntry["health"], { label: string; cls: string }> = {
  good: { label: "On track", cls: "border-teal-500/40 bg-teal-500/10 text-teal-300" },
  watch: { label: "Watch", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  risk: { label: "At risk", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
  none: { label: "No data", cls: "border-charcoal-700 bg-charcoal-800 text-ink-muted" },
};

const VALIDATION_LABEL: Record<MetricEntry["validation_status"], string> = {
  validated: "Validated",
  unvalidated: "Recorded",
  no_data: "No data",
};

const PRIORITY_CLS: Record<Recommendation["priority"], string> = {
  high: "border-red-500/40 bg-red-500/10 text-red-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  low: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
};

const SCENARIO_META: Record<ScenarioName, { label: string; badge: string; bar: string }> = {
  best: { label: "Best case", badge: "border-teal-500/40 bg-teal-500/10 text-teal-300", bar: "bg-teal-400" },
  base: { label: "Base case", badge: "border-violet-500/40 bg-violet-500/10 text-violet-300", bar: "bg-violet-400" },
  worst: { label: "Worst case", badge: "border-amber-500/40 bg-amber-500/10 text-amber-300", bar: "bg-amber-400" },
};

function fmtValue(e: Pick<MetricEntry, "value" | "unit">): string {
  if (e.value === null) return DASH;
  const v = e.value;
  switch (e.unit) {
    case "PHP":
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(v);
      } catch {
        return `PHP ${Math.round(v)}`;
      }
    case "%":
      return `${Math.round(v * 100) / 100}%`;
    case "ratio":
      return `${Math.round(v * 10000) / 100}%`;
    case "x":
      return `${Math.round(v * 100) / 100}×`;
    case "count":
      return new Intl.NumberFormat("en-US").format(Math.round(v));
    default:
      return String(v);
  }
}

function fmtTarget(e: MetricEntry): string {
  return e.target === null ? DASH : fmtValue({ value: e.target, unit: e.unit });
}

function fmtVariance(e: MetricEntry): string {
  if (e.variance_pct !== null) {
    const p = Math.round(e.variance_pct * 100);
    return `${p >= 0 ? "+" : ""}${p}%`;
  }
  if (e.variance !== null) {
    const v = Math.round(e.variance * 100) / 100;
    return `${e.variance >= 0 ? "+" : ""}${v}`;
  }
  return DASH;
}

function firstOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AccountReviewBriefPanel({
  departments,
  brands,
  canGenerate,
  history,
}: {
  departments: NamedRow[];
  brands: NamedRow[];
  canGenerate: boolean;
  history: HistoryRow[];
}) {
  const [department, setDepartment] = useState<string>("Organization");
  const [brandId, setBrandId] = useState<string>("");
  const [periodStart, setPeriodStart] = useState<string>(firstOfMonth());
  const [periodEnd, setPeriodEnd] = useState<string>(today());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BriefResult | null>(null);
  // recommendation index → "sending" | "sent" | error string
  const [recState, setRecState] = useState<Record<number, string>>({});
  // scenario index → "sending" | "sent" | error string
  const [scenState, setScenState] = useState<Record<number, string>>({});

  const scopeQuery = useMemo(() => {
    if (!result) return "";
    const p = new URLSearchParams({
      department: result.scope.department,
      period_start: result.scope.period_start,
      period_end: result.scope.period_end,
      brief_id: result.brief_id,
    });
    if (brandId) p.set("brand_id", brandId);
    return p.toString();
  }, [result, brandId]);

  async function generate() {
    setLoading(true);
    setError("");
    setRecState({});
    setScenState({});
    try {
      const res = await fetch("/api/metrics/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department,
          brand_id: brandId || null,
          period_start: periodStart,
          period_end: periodEnd,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setResult(data as BriefResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function reopen(id: string) {
    setLoading(true);
    setError("");
    setRecState({});
    setScenState({});
    try {
      const res = await fetch(`/api/metrics/brief?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load brief");
      setResult(data as BriefResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function sendToApproval(index: number) {
    if (!result) return;
    setRecState((s) => ({ ...s, [index]: "sending" }));
    try {
      const res = await fetch("/api/metrics/brief/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief_id: result.brief_id, recommendation_index: index }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not stage approval");
      setRecState((s) => ({ ...s, [index]: data.already ? "sent" : "sent" }));
    } catch (e) {
      setRecState((s) => ({ ...s, [index]: e instanceof Error ? e.message : "failed" }));
    }
  }

  async function sendScenarioToApproval(index: number) {
    if (!result) return;
    setScenState((s) => ({ ...s, [index]: "sending" }));
    try {
      const res = await fetch("/api/metrics/brief/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief_id: result.brief_id, scenario_index: index }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not stage approval");
      setScenState((s) => ({ ...s, [index]: "sent" }));
    } catch (e) {
      setScenState((s) => ({ ...s, [index]: e instanceof Error ? e.message : "failed" }));
    }
  }

  const p = result?.payload;
  const scenarios = p?.scenarios ?? [];
  const scenarioMeta = p?.scenario_meta ?? null;
  // Map metric key → label so a scenario's evidence links can name the row.
  const entryLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of result?.entries ?? []) m.set(e.key, e.label);
    return m;
  }, [result]);

  return (
    <section className="mb-10 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">AI Account Review Brief</h2>
          <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
            Grounded · human-approved
          </span>
        </div>
      </div>

      <p className="mb-4 text-xs text-ink-muted">
        Tony reads the real recorded metrics for a scope + period and writes a management-ready review. It never invents
        numbers — metrics with no recorded value are shown as &ldquo;{DASH}&rdquo; and reported as no data. Recommendations
        are suggestions: &ldquo;Send to approval&rdquo; stages a pending request, nothing runs automatically.
      </p>

      {/* Scope form */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-ink-muted">
          Department
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            <option value="Organization">Organization (all departments)</option>
            {departments.map((d) => (
              <option key={d.id} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Brand / client (optional)
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            <option value="">No brand scope</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Period start
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          />
        </label>
        <label className="text-xs text-ink-muted">
          Period end
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canGenerate ? (
          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
          >
            {loading ? "Generating…" : result ? "Regenerate brief" : "Generate brief"}
          </button>
        ) : (
          <p className="text-xs text-ink-muted">Briefs are generated by department heads and above.</p>
        )}
        {result && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-ink-muted">Export:</span>
            {(["csv", "xlsx", "pdf"] as const).map((f) => (
              <a
                key={f}
                href={`/api/metrics/export?format=${f}&${scopeQuery}`}
                className="rounded-md border border-charcoal-700 px-2.5 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-800"
              >
                {f.toUpperCase()}
              </a>
            ))}
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      {/* Result */}
      {result && p && (
        <div className="mt-6 space-y-6">
          {/* Rollup header */}
          <div className="flex flex-wrap items-center gap-3 border-b border-charcoal-700/60 pb-4">
            <span className="text-sm font-semibold text-ink">
              {result.scope.department}
              {result.scope.brand_name ? ` · ${result.scope.brand_name}` : ""}
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {result.scope.period_start} → {result.scope.period_end}
            </span>
            {result.rollup && (
              <span className="rounded-full border border-charcoal-700 bg-charcoal-950 px-2.5 py-0.5 text-xs text-ink">
                Health: <span className="font-semibold">{result.rollup.label}</span>
                {result.rollup.score !== null ? ` · ${result.rollup.score}/100` : ""}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              {p.meta.grounded
                ? `grounded on ${p.meta.metrics_with_data}/${p.meta.metrics_total} real metrics${p.meta.model ? ` · ${p.meta.model}` : ""}`
                : "not model-grounded — metrics shown as recorded"}
            </span>
          </div>

          {/* Metrics table */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">Metrics (grounded)</h3>
            <div className="overflow-x-auto rounded-lg border border-charcoal-700/60">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-charcoal-700/60 text-[11px] uppercase tracking-wider text-ink-muted">
                    <th className="p-2.5 font-medium">Metric</th>
                    <th className="p-2.5 font-medium">Value</th>
                    <th className="p-2.5 font-medium">Target</th>
                    <th className="p-2.5 font-medium">Variance</th>
                    <th className="p-2.5 font-medium">Health</th>
                    <th className="p-2.5 font-medium">Validation</th>
                    <th className="p-2.5 font-medium">Origin</th>
                  </tr>
                </thead>
                <tbody>
                  {result.entries.map((e) => (
                    <tr key={e.key} id={`metric-${e.key}`} className="scroll-mt-24 border-b border-charcoal-800/60 last:border-0">
                      <td className="p-2.5 text-ink">{e.label}</td>
                      <td className={`p-2.5 font-mono ${e.value === null ? "text-ink-muted" : "text-ink"}`}>{fmtValue(e)}</td>
                      <td className="p-2.5 font-mono text-ink-muted">{fmtTarget(e)}</td>
                      <td className="p-2.5 font-mono text-ink-muted">{fmtVariance(e)}</td>
                      <td className="p-2.5">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${HEALTH_META[e.health].cls}`}>
                          {HEALTH_META[e.health].label}
                        </span>
                      </td>
                      <td className="p-2.5 text-[11px] text-ink-muted">{VALIDATION_LABEL[e.validation_status]}</td>
                      <td className="p-2.5 text-[11px] text-ink-muted">{e.origin}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.mismatch_flags.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.mismatch_flags.map((f, i) => (
                  <li key={i} className="text-[11px] text-amber-300/90">
                    ⚠ {f}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Executive summary */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">Executive summary</h3>
            <p className="text-sm leading-relaxed text-ink">{p.executive_summary || DASH}</p>
          </div>

          {/* Scenarios (AI Brief 2.0) */}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                Scenarios <span className="normal-case text-ink-muted">— best / base / worst, grounded in real variance</span>
              </h3>
              {scenarioMeta && (
                <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                  {scenarioMeta.grounded
                    ? `deep · projected on ${scenarioMeta.scored_metrics} judged metric(s)${scenarioMeta.model ? ` · ${scenarioMeta.model}` : ""}`
                    : "direction-only — grounded in the recorded variance"}
                </span>
              )}
            </div>

            {scenarioMeta?.low_data && (
              <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300/90">
                ⚠ Limited data for this scope
                {typeof scenarioMeta.data_density === "number"
                  ? ` (${Math.round(scenarioMeta.data_density * 100)}% metric coverage, ${scenarioMeta.scored_metrics} judged)`
                  : ""}
                — these projections are directional and confidence is capped honestly.
                {scenarioMeta.note ? ` ${scenarioMeta.note}` : ""}
              </p>
            )}

            {scenarios.length ? (
              <div className="grid gap-3 lg:grid-cols-3">
                {scenarios.map((sc, i) => {
                  const meta = SCENARIO_META[sc.name];
                  const st = scenState[i];
                  const sent = st === "sent";
                  const sending = st === "sending";
                  const failed = st && st !== "sent" && st !== "sending";
                  const pct = Math.round((sc.confidence ?? 0) * 100);
                  return (
                    <div key={i} className="flex flex-col rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${meta.badge}`}>
                          {meta.label}
                        </span>
                        <span className="font-mono text-[11px] text-ink-muted">{pct}% conf.</span>
                      </div>

                      {/* Confidence bar */}
                      <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
                        <div className={`h-full rounded-full ${meta.bar}`} style={{ width: `${Math.max(4, pct)}%` }} />
                      </div>

                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Premise</p>
                      <p className="mb-2 text-xs text-ink">{sc.premise || DASH}</p>

                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Projected outcome</p>
                      <p className="mb-2 text-xs text-ink">{sc.projected_outcome || DASH}</p>

                      {/* Drivers → evidence links back to the metric rows */}
                      {sc.drivers.length > 0 && (
                        <div className="mb-3">
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Evidence</p>
                          <div className="flex flex-wrap gap-1.5">
                            {sc.drivers.map((d, di) => {
                              const key = sc.evidence_keys[di];
                              const label = (key && entryLabel.get(key)) || d;
                              return key ? (
                                <a
                                  key={di}
                                  href={`#metric-${key}`}
                                  className="rounded-full border border-charcoal-700 bg-charcoal-900 px-2 py-0.5 text-[10px] text-teal-300 hover:bg-charcoal-800"
                                  title="Jump to the metric this projection rests on"
                                >
                                  {label} ↗
                                </a>
                              ) : (
                                <span key={di} className="rounded-full border border-charcoal-700 bg-charcoal-900 px-2 py-0.5 text-[10px] text-ink-muted">
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="mt-auto pt-1">
                        {sent ? (
                          <span className="inline-flex items-center rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-semibold text-teal-300">
                            Pending approval ✓
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => sendScenarioToApproval(i)}
                            disabled={sending}
                            className="w-full rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 disabled:opacity-60"
                          >
                            {sending ? "Sending…" : "Send to approval"}
                          </button>
                        )}
                        {failed && <p className="mt-1.5 text-[11px] text-red-400">{st}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">
                {scenarioMeta?.note ?? "No scenarios — the data did not support a grounded projection."}
              </p>
            )}
          </div>

          {/* Overall performance */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">Overall performance</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["Sales trend", p.overall_performance.sales_trend],
                  ["Traffic trend", p.overall_performance.traffic_trend],
                  ["Conversion trend", p.overall_performance.conversion_trend],
                  ["Operational efficiency", p.overall_performance.operational_efficiency],
                ] as const
              ).map(([label, val]) => (
                <div key={label} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
                  <p className="text-sm text-ink">{val || DASH}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Highlights + concerns */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-teal-300">Highlights</h3>
              {p.highlights.length ? (
                <ul className="space-y-1.5">
                  {p.highlights.map((h, i) => (
                    <li key={i} className="text-sm text-ink">
                      • {h}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">No highlights the data supports.</p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-300">Concerns</h3>
              {p.concerns.length ? (
                <ul className="space-y-1.5">
                  {p.concerns.map((c, i) => (
                    <li key={i} className="text-sm text-ink">
                      • {c}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">No concerns the data supports.</p>
              )}
            </div>
          </div>

          {/* Recommendations */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Recommendations <span className="normal-case text-ink-muted">— suggestions only; approval required</span>
            </h3>
            {p.recommendations.length ? (
              <ul className="space-y-3">
                {p.recommendations.map((r, i) => {
                  const st = recState[i];
                  const sent = st === "sent";
                  const sending = st === "sending";
                  const failed = st && st !== "sent" && st !== "sending";
                  return (
                    <li key={i} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="mb-1 flex items-center gap-2">
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${PRIORITY_CLS[r.priority]}`}>
                              {r.priority}
                            </span>
                            <span className="text-[11px] text-ink-muted">→ {r.target_department}</span>
                          </div>
                          <p className="text-sm font-medium text-ink">{r.action}</p>
                          {r.rationale && <p className="mt-1 text-xs text-ink-muted">{r.rationale}</p>}
                        </div>
                        <div className="shrink-0">
                          {sent ? (
                            <span className="inline-flex items-center rounded-md border border-teal-500/40 bg-teal-500/10 px-3 py-1.5 text-xs font-semibold text-teal-300">
                              Pending approval ✓
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => sendToApproval(i)}
                              disabled={sending}
                              className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 disabled:opacity-60"
                            >
                              {sending ? "Sending…" : "Send to approval"}
                            </button>
                          )}
                        </div>
                      </div>
                      {failed && <p className="mt-1.5 text-[11px] text-red-400">{st}</p>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">No recommendations — the data did not support any.</p>
            )}
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="mt-8 border-t border-charcoal-700/60 pt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">Brief history</h3>
          <ul className="space-y-1.5">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-charcoal-800/60 bg-charcoal-950 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">
                    {h.department}
                    <span className="ml-2 font-mono text-[11px] text-ink-muted">
                      {h.period_start} → {h.period_end}
                    </span>
                  </p>
                  {h.summary && <p className="truncate text-[11px] text-ink-muted">{h.summary}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => reopen(h.id)}
                  className="shrink-0 rounded-md border border-charcoal-700 px-2.5 py-1 text-xs font-medium text-teal-300 hover:bg-charcoal-800"
                >
                  Re-open
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
