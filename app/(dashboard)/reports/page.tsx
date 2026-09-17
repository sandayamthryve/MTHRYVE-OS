import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, StatTile, TableShell, rowClass } from "@/components/ui";
import { MetricEntryForm } from "@/components/reports/MetricEntryForm";
import { GenerateReportButton } from "@/components/reports/GenerateReportButton";
import { AiBrief } from "@/components/briefings/AiBrief";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { customWindow, manilaStamp } from "@/lib/metrics/windows";
import { fetchCommerceRows, aggregate } from "@/lib/metrics/gmv";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import { getDataFreshness } from "@/lib/metrics/freshness";
import { peso as fmtPeso, int as fmtInt } from "@/lib/metrics/format";

type MetricLite = {
  department_id: string | null;
  gmv_impact: number;
  efficiency: number;
  quality_score: number;
  capacity_utilization: number;
  period_end: string;
};
type NamedRow = { id: string; name: string };
type ReportRowContent = {
  rows?: Array<{
    department: string;
    gmv_impact: number;
    efficiency: number;
    quality_score: number;
    capacity_utilization: number;
  }>;
  totals?: { gmv_impact: number; avg_efficiency: number; avg_quality: number; avg_capacity: number };
};
type ReportLite = {
  id: string;
  title: string;
  period_start: string;
  period_end: string;
  created_at: string;
  content: ReportRowContent | null;
};

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams?: DateRangeSearchParams & { dept?: string };
}) {
  const profile = await requireProfile();
  const canManage = ["ceo", "coo", "department_head"].includes(profile.role);
  const supabase = createServerSupabaseClient();

  // Shared date-range control (defaults to MTD) — the same Today/…/Custom picker
  // as every other dashboard, replacing the older WindowSwitcher. The org GMV
  // rollup re-slices to the selected window through the shared aggregation.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const win = customWindow(dr.range.start, dr.range.end, dr.rangeLabel);
  const selectedDeptId = (searchParams?.dept ?? "").trim();

  const [metricsRes, deptsRes, reportsRes, bpmRows, freshness] = await Promise.all([
    supabase
      .from("metrics_snapshots")
      .select("department_id, gmv_impact, efficiency, quality_score, capacity_utilization, period_end")
      .not("department_id", "is", null) // exclude org-level signal snapshots
      .order("period_end", { ascending: false }),
    supabase.from("departments").select("id, name").order("name"),
    supabase
      .from("reports")
      .select("id, title, period_start, period_end, created_at, content")
      .order("created_at", { ascending: false })
      .limit(10),
    fetchCommerceRows(supabase),
    getDataFreshness(supabase),
  ]);

  const allMetrics = (metricsRes.data ?? []) as unknown as MetricLite[];
  const departments = (deptsRes.data ?? []) as unknown as NamedRow[];
  const reports = (reportsRes.data ?? []) as unknown as ReportLite[];
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  // Only honour a ?dept= that resolves to a real, RLS-visible department.
  const selectedDept = departments.find((d) => d.id === selectedDeptId) ?? null;

  // Commerce GMV for the resolved window — the SAME shared aggregation the
  // Command Center and Brand Portfolio use, so the org total matches across all
  // three surfaces for a given window.
  const orgAgg = aggregate(bpmRows, win);

  // Latest snapshot per department.
  const latestByDept = new Map<string, MetricLite>();
  for (const m of allMetrics) {
    const key = m.department_id ?? "unassigned";
    if (!latestByDept.has(key)) latestByDept.set(key, m);
  }
  const latest = Array.from(latestByDept.values());

  const orgAvg = (pick: (m: MetricLite) => number) =>
    latest.length
      ? Math.round((latest.reduce((a, m) => a + Number(pick(m)), 0) / latest.length) * 10) / 10
      : 0;
  const gmvTotal = latest.reduce((a, m) => a + Number(m.gmv_impact), 0);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Report Archive"]} profile={profile}>
    <PageHeader
  title="Report Archive"
  action={
    <GenerateReportButton
      orgId={profile.org_id}
      userId={profile.id}
      departments={departments}
    />
  }
/>
      {/* ── AI briefing engine surfaced on Reports: the how & why + the plan ── */}
      <section className="mb-8 space-y-4">
        {/* Latest org brief — summary + KPI chips + highlights (all roles read;
            any role can generate — RLS allows org-wide inserts). */}
        <AiBrief scope="org" />

        {/* Per-department action plan. Team members READ the plan but cannot
            generate one — department generation is ceo/coo/department_head only
            (RLS-enforced), so we hide the Generate button for them. */}
        <div>
          <form action="/reports" method="get" className="mb-4 flex flex-wrap gap-2">
            {/* Preserve the active window when switching department plans. */}
            <input type="hidden" name="preset" value={dr.preset} />
            {dr.preset === "custom" ? (
              <>
                <input type="hidden" name="period_start" value={dr.range.start} />
                <input type="hidden" name="period_end" value={dr.range.end} />
              </>
            ) : null}
            <select
              name="dept"
              defaultValue={selectedDept?.id ?? ""}
              className="w-full max-w-sm rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            >
              <option value="">Select a department…</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              View plan
            </button>
          </form>
          {selectedDept ? (
            <AiBrief scope="department" id={selectedDept.id} canGenerate={canManage} />
          ) : (
            <p className="text-sm text-ink-muted">
              Pick a department to see its challenges and the numbered action plan (owners &amp; dates intact).
            </p>
          )}
        </div>
      </section>

      {/* Shared date-range control — replaces the older WindowSwitcher so Reports
          matches every other dashboard. Brand + Compare levers aren't wired on
          this org rollup, so the picker hides them. */}
      <DateRangeControls {...dr.controlProps} brands={[]} showBrand={false} showCompare={false} />

      {/* Commerce GMV for the resolved window (shared metrics layer). */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Org GMV <span className="font-mono text-[11px] text-ink-dim">· {win.label}</span>
          </h2>
        </div>
        {freshness.asOf && (
          <span className="font-mono text-[10px] text-ink-dim">
            Data as of {manilaStamp(freshness.asOf)} · Manila
          </span>
        )}
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile
          label={`GMV · ${win.label}`}
          value={orgAgg.hasData ? fmtPeso(orgAgg.gmv) : "—"}
          valueClassName="text-gold-400"
          hint={orgAgg.hasData ? `${fmtInt(orgAgg.orders)} orders` : "No data yet"}
        />
        <StatTile
          label="Units"
          value={orgAgg.hasData ? fmtInt(orgAgg.units) : "—"}
          valueClassName="text-green-400"
        />
        <StatTile
          label="AOV"
          value={orgAgg.aov != null ? fmtPeso(orgAgg.aov) : "—"}
          hint="GMV / orders"
        />
        <StatTile
          label="Return rate"
          value={orgAgg.returnRate != null ? `${(orgAgg.returnRate * 100).toFixed(1)}%` : "—"}
        />
      </div>

      {/* Department metric rollup (universal metric set) */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Total GMV impact" value={fmtNum(gmvTotal)} valueClassName="text-gold-400" />
        <StatTile label="Avg efficiency" value={orgAvg((m) => m.efficiency)} valueClassName="text-green-400" />
        <StatTile label="Avg quality" value={orgAvg((m) => m.quality_score)} />
        <StatTile label="Avg capacity" value={orgAvg((m) => m.capacity_utilization)} />
      </div>

      {/* Current metrics per department */}
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Latest metrics by department</h2>
          {canManage && (
            <MetricEntryForm orgId={profile.org_id} userId={profile.id} departments={departments} />
          )}
        </div>
        {latest.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
            No metrics recorded yet.{canManage ? " Use “Record metrics” to add the first snapshot." : ""}
          </div>
        ) : (
          <TableShell
            columns={["Department", "GMV impact", "Efficiency", "Quality", "Capacity"]}
          >
            {latest.map((m, i) => (
                  <tr key={i} className={`${rowClass} font-mono text-xs`}>
                    <td className="px-4 py-2.5 font-sans text-sm text-ink">
                      {m.department_id ? deptName.get(m.department_id) ?? "—" : "Unassigned"}
                    </td>
                    <td className="px-4 py-2.5 text-gold-400">{fmtNum(Number(m.gmv_impact))}</td>
                    <td className="px-4 py-2.5 text-green-400">{Number(m.efficiency)}</td>
                    <td className="px-4 py-2.5 text-ink">{Number(m.quality_score)}</td>
                    <td className="px-4 py-2.5 text-ink">{Number(m.capacity_utilization)}</td>
                  </tr>
                ))}
          </TableShell>
        )}
      </section>

      {/* Generated reports */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">Generated reports</h2>
        {reports.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
            No reports yet. Click “Generate weekly report” to roll up the last 7 days.
          </div>
        ) : (
          <div className="space-y-4">
            {reports.map((r) => {
              const totals = r.content?.totals;
              const rows = r.content?.rows ?? [];
              return (
                <details
                  key={r.id}
                  className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4"
                >
                  <summary className="cursor-pointer text-sm font-medium text-ink">
                    {r.title}
                    <span className="ml-2 font-mono text-[10px] text-ink-muted">
                      {new Date(r.created_at).toISOString().slice(0, 10)}
                    </span>
                  </summary>
                  {totals && (
                    <p className="mt-3 text-xs text-ink-muted">
                      Total GMV impact {fmtNum(totals.gmv_impact)} · avg efficiency{" "}
                      {totals.avg_efficiency} · avg quality {totals.avg_quality} · avg capacity{" "}
                      {totals.avg_capacity}
                    </p>
                  )}
                  {rows.length > 0 && (
                    <ul className="mt-2 divide-y divide-charcoal-700/70">
                      {rows.map((row, i) => (
                        <li key={i} className="flex items-center justify-between py-1.5 text-xs">
                          <span className="text-ink">{row.department}</span>
                          <span className="font-mono text-ink-muted">
                            GMV {fmtNum(row.gmv_impact)} · eff {row.efficiency} · qual{" "}
                            {row.quality_score} · cap {row.capacity_utilization}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              );
            })}
          </div>
        )}
      </section>
    </AppShell>
  );
}
