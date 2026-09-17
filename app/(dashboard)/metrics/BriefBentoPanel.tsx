"use client";

import { useMemo, useState } from "react";

type NamedRow = { id: string; name: string };
export type BriefHistoryRow = {
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
  health: "good" | "watch" | "risk" | "none";
  validation_status: string;
};

type Recommendation = {
  action: string;
  rationale: string;
  priority: "high" | "medium" | "low";
  target_department: string;
};

type Scenario = {
  name: "best" | "base" | "worst";
  premise: string;
  projected_outcome: string;
  confidence: number;
};

type BriefPayload = {
  executive_summary: string;
  highlights: string[];
  concerns: string[];
  recommendations: Recommendation[];
  scenarios?: Scenario[];
  overall_performance: {
    sales_trend: string;
    traffic_trend: string;
    conversion_trend: string;
    operational_efficiency: string;
  };
  meta: {
    grounded: boolean;
    model: string | null;
    metrics_with_data: number;
    metrics_total: number;
  };
};

type BriefResult = {
  brief_id: string;
  created_at: string;
  scope: {
    department: string;
    brand_name: string | null;
    period_start: string;
    period_end: string;
  };
  entries: MetricEntry[];
  rollup: { label: string; score: number | null } | null;
  mismatch_flags: string[];
  payload: BriefPayload;
};

const controlClass =
  "h-9 w-full rounded-lg border border-charcoal-700/70 bg-charcoal-950 px-2.5 text-xs text-ink outline-none transition focus:border-teal-500/60 focus:ring-1 focus:ring-teal-500/20";
const hiddenScroll = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatValue(entry: MetricEntry) {
  if (entry.value == null) return "—";
  if (entry.unit === "PHP") {
    return new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(entry.value);
  }
  if (entry.unit === "%") return `${Math.round(entry.value * 100) / 100}%`;
  if (entry.unit === "ratio") return `${Math.round(entry.value * 10000) / 100}%`;
  if (entry.unit === "x") return `${Math.round(entry.value * 100) / 100}×`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(entry.value);
}

function healthClass(health: MetricEntry["health"]) {
  if (health === "good") return "border-teal-500/30 bg-teal-500/10 text-teal-300";
  if (health === "watch") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  if (health === "risk") return "border-red-500/30 bg-red-500/10 text-red-300";
  return "border-charcoal-700 bg-charcoal-800 text-ink-muted";
}

export function BriefBentoPanel({
  departments,
  brands,
  history,
  canGenerate,
}: {
  departments: NamedRow[];
  brands: NamedRow[];
  history: BriefHistoryRow[];
  canGenerate: boolean;
}) {
  const [department, setDepartment] = useState("Organization");
  const [brandId, setBrandId] = useState("");
  const [periodStart, setPeriodStart] = useState(firstOfMonth());
  const [periodEnd, setPeriodEnd] = useState(today());
  const [result, setResult] = useState<BriefResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showViewer, setShowViewer] = useState(false);
  const [recState, setRecState] = useState<Record<number, string>>({});

  const matchingHistory = useMemo(() => {
    return history
      .filter((brief) => {
        const deptOk = department === "Organization" || brief.department === department;
        const brandOk = !brandId || brief.brand_id === brandId;
        const dateOk = brief.period_end >= periodStart && brief.period_start <= periodEnd;
        return deptOk && brandOk && dateOk;
      })
      .sort((a, b) => {
        const byDate = a.period_start.localeCompare(b.period_start);
        return byDate || a.created_at.localeCompare(b.created_at);
      });
  }, [history, department, brandId, periodStart, periodEnd]);

  async function generate() {
    setLoading(true);
    setError("");
    setRecState({});
    try {
      const response = await fetch("/api/metrics/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department,
          brand_id: brandId || null,
          period_start: periodStart,
          period_end: periodEnd,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Generation failed");
      setResult(data as BriefResult);
      setShowViewer(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate brief");
    } finally {
      setLoading(false);
    }
  }

  async function reopen(id: string) {
    setLoading(true);
    setError("");
    setRecState({});
    try {
      const response = await fetch(`/api/metrics/brief?id=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load brief");
      setResult(data as BriefResult);
      setShowViewer(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load brief");
    } finally {
      setLoading(false);
    }
  }

  async function sendToApproval(index: number) {
    if (!result) return;
    setRecState((state) => ({ ...state, [index]: "sending" }));
    try {
      const response = await fetch("/api/metrics/brief/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief_id: result.brief_id, recommendation_index: index }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not stage approval");
      setRecState((state) => ({ ...state, [index]: "sent" }));
    } catch (err) {
      setRecState((state) => ({
        ...state,
        [index]: err instanceof Error ? err.message : "Failed",
      }));
    }
  }

  const exportQuery = result
    ? new URLSearchParams({
        department: result.scope.department,
        period_start: result.scope.period_start,
        period_end: result.scope.period_end,
        brief_id: result.brief_id,
        ...(brandId ? { brand_id: brandId } : {}),
      }).toString()
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-2 gap-2 xl:grid-cols-4">
        <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-dim">
          Department
          <select value={department} onChange={(e) => setDepartment(e.target.value)} className={`${controlClass} mt-1 normal-case tracking-normal`}>
            <option value="Organization">Organization</option>
            {departments.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
          </select>
        </label>
        <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-dim">
          Brand / Client
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={`${controlClass} mt-1 normal-case tracking-normal`}>
            <option value="">All brands</option>
            {brands.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-dim">
          Start date
          <input type="date" value={periodStart} max={periodEnd} onChange={(e) => setPeriodStart(e.target.value)} className={`${controlClass} mt-1 normal-case tracking-normal`} />
        </label>
        <label className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-dim">
          End date
          <input type="date" value={periodEnd} min={periodStart} onChange={(e) => setPeriodEnd(e.target.value)} className={`${controlClass} mt-1 normal-case tracking-normal`} />
        </label>
      </div>

      <div className="mt-3 flex shrink-0 items-center justify-between gap-2 border-b border-charcoal-700/50 pb-3">
        <div>
          <p className="text-xs font-semibold text-ink">View Briefs</p>
          <p className="text-[10px] text-ink-dim">{matchingHistory.length} matching · oldest first</p>
        </div>
        <div className="flex items-center gap-2">
          {result && (
            <button type="button" onClick={() => setShowViewer((value) => !value)} className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-2.5 py-1.5 text-[11px] font-medium text-teal-300 hover:bg-charcoal-800">
              {showViewer ? "Back to list" : "Open brief"}
            </button>
          )}
          {canGenerate && (
            <button type="button" onClick={generate} disabled={loading || !periodStart || !periodEnd} className="rounded-lg bg-teal-500 px-3 py-1.5 text-[11px] font-semibold text-charcoal-950 transition hover:bg-teal-400 disabled:opacity-50">
              {loading ? "Generating…" : "Generate Brief"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 shrink-0 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">{error}</p>}

      {!showViewer ? (
        <div className={`mt-2 min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto pr-0.5 ${hiddenScroll}`}>
          {matchingHistory.length === 0 ? (
            <div className="flex h-full min-h-24 items-center justify-center rounded-xl border border-dashed border-charcoal-700/70 bg-charcoal-950/40 px-4 text-center text-xs text-ink-dim">
              No generated briefs match these filters yet.
            </div>
          ) : (
            <div className="space-y-2">
              {matchingHistory.map((brief) => (
                <article key={brief.id} className="snap-start rounded-xl border border-charcoal-700/60 bg-charcoal-950/70 p-3 transition hover:border-charcoal-600 hover:bg-charcoal-950">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-xs font-semibold text-ink">{brief.department} Review Brief</h3>
                        <span className="font-mono text-[9px] text-ink-dim">{brief.period_start} → {brief.period_end}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-muted">{brief.summary || "Generated account review. Open to view the complete grounded brief."}</p>
                    </div>
                    <button type="button" onClick={() => reopen(brief.id)} disabled={loading} className="shrink-0 rounded-md border border-charcoal-700 px-2.5 py-1 text-[10px] font-semibold text-teal-300 hover:bg-charcoal-800 disabled:opacity-50">
                      View Brief
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : result ? (
        <div className={`mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 ${hiddenScroll}`}>
          <div className="space-y-4 pb-2">
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-ink">{result.scope.department}{result.scope.brand_name ? ` · ${result.scope.brand_name}` : ""}</h3>
                  <p className="font-mono text-[10px] text-ink-dim">{result.scope.period_start} → {result.scope.period_end}</p>
                </div>
                {result.rollup && <span className="rounded-full border border-charcoal-700 bg-charcoal-950 px-2.5 py-1 text-[10px] text-ink-muted">Health <b className="text-ink">{result.rollup.label}{result.rollup.score != null ? ` · ${result.rollup.score}/100` : ""}</b></span>}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-ink">{result.payload.executive_summary || "—"}</p>
              <p className="mt-2 font-mono text-[9px] uppercase tracking-wider text-ink-dim">Grounded on {result.payload.meta.metrics_with_data}/{result.payload.meta.metrics_total} metrics{result.payload.meta.model ? ` · ${result.payload.meta.model}` : ""}</p>
            </div>

            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-dim">Metrics</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {result.entries.map((entry) => (
                  <div key={entry.key} className="rounded-lg border border-charcoal-700/50 bg-charcoal-950 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] text-ink-muted">{entry.label}</p>
                        <p className="mt-0.5 font-mono text-sm text-ink">{formatValue(entry)}</p>
                      </div>
                      <span className={`rounded-full border px-2 py-0.5 text-[9px] capitalize ${healthClass(entry.health)}`}>{entry.health === "none" ? "no data" : entry.health}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {(result.payload.highlights.length > 0 || result.payload.concerns.length > 0) && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-teal-500/20 bg-teal-500/[0.03] p-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-teal-300">Highlights</p>
                  <ul className="space-y-1.5 text-[11px] leading-relaxed text-ink-muted">{result.payload.highlights.map((item, index) => <li key={index}>• {item}</li>)}</ul>
                </div>
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-amber-300">Concerns</p>
                  <ul className="space-y-1.5 text-[11px] leading-relaxed text-ink-muted">{result.payload.concerns.map((item, index) => <li key={index}>• {item}</li>)}</ul>
                </div>
              </div>
            )}

            {result.payload.scenarios && result.payload.scenarios.length > 0 && (
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-dim">Scenarios</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {result.payload.scenarios.map((scenario, index) => (
                    <div key={index} className="rounded-lg border border-charcoal-700/50 bg-charcoal-950 p-2.5">
                      <div className="flex items-center justify-between"><span className="text-[10px] font-semibold uppercase text-teal-300">{scenario.name}</span><span className="font-mono text-[9px] text-ink-dim">{Math.round((scenario.confidence || 0) * 100)}%</span></div>
                      <p className="mt-2 text-[11px] text-ink">{scenario.premise}</p>
                      <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">{scenario.projected_outcome}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-dim">Recommendations · approval required</p>
              <div className="space-y-2">
                {result.payload.recommendations.map((recommendation, index) => {
                  const state = recState[index];
                  return (
                    <div key={index} className="rounded-lg border border-charcoal-700/50 bg-charcoal-950 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><p className="text-[11px] font-medium text-ink">{recommendation.action}</p><p className="mt-1 text-[10px] leading-relaxed text-ink-muted">{recommendation.rationale}</p></div>
                        <button type="button" disabled={state === "sending" || state === "sent"} onClick={() => sendToApproval(index)} className="shrink-0 rounded-md bg-charcoal-800 px-2.5 py-1.5 text-[10px] font-semibold text-teal-300 hover:bg-charcoal-700 disabled:opacity-60">{state === "sending" ? "Sending…" : state === "sent" ? "Pending ✓" : "Approve…"}</button>
                      </div>
                      {state && state !== "sending" && state !== "sent" && <p className="mt-1 text-[10px] text-red-300">{state}</p>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-charcoal-700/50 pt-3">
              <span className="text-[10px] text-ink-dim">Export grounded brief</span>
              <div className="flex gap-1.5">{(["csv", "xlsx", "pdf"] as const).map((format) => <a key={format} href={`/api/metrics/export?format=${format}&${exportQuery}`} className="rounded-md border border-charcoal-700 px-2 py-1 text-[10px] font-semibold text-teal-300 hover:bg-charcoal-800">{format.toUpperCase()}</a>)}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
