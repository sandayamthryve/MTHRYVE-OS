import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, Badge, rowClass } from "@/components/ui";
import { LiveOpsTabs } from "@/components/live-ops/LiveOpsTabs";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manilaStamp } from "@/lib/metrics/windows";
import {
  CATEGORY_LABEL,
  CATEGORY_DEPARTMENT,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  BOTTLENECK_STATUSES,
  rollupByCategory,
  type LiveBottleneck,
} from "@/lib/live-ops/bottlenecks";
import { assignBottleneck, updateBottleneckStatus } from "../actions";

// PART D — Bottleneck Monitoring.
//
// Consolidates live_bottlenecks by category / brand / severity, with drill-down
// and assignment (assign → creates a task, notifies via the task, records the
// transition to action_audit). Trend monitoring surfaces recurring issues and
// the most-affected brands.

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink";

type Brand = { id: string; name: string };
type Person = { id: string; full_name: string };

const DEPARTMENTS = ["Live Operations", "E-Commerce", "Warehouse", "Customer Service", "Creatives", "Affiliate", "Finance", "Business Development"];

interface SearchParams { category?: string; brand?: string; severity?: string; status?: string }

export default async function BottlenecksPage({ searchParams }: { searchParams?: SearchParams }) {
  const profile = await requireModule("/live-ops");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const [bottleRes, brandsRes, usersRes] = await Promise.all([
    u.from("live_bottlenecks").select("*").order("created_at", { ascending: false }),
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
  ]);

  const all = (bottleRes.data ?? []) as LiveBottleneck[];
  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const people = (usersRes.data ?? []) as unknown as Person[];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";

  const fCat = searchParams?.category ?? "";
  const fBrand = searchParams?.brand ?? "";
  const fSev = searchParams?.severity ?? "";
  const fStatus = searchParams?.status ?? "";
  const rows = all.filter(
    (b) =>
      (!fCat || b.category === fCat) &&
      (!fBrand || b.brand_id === fBrand) &&
      (!fSev || b.severity === fSev) &&
      (!fStatus || b.status === fStatus)
  );

  const openCount = all.filter((b) => ["open", "assigned", "in_progress"].includes(b.status)).length;
  const criticalCount = all.filter((b) => b.severity === "critical").length;
  const resolvedCount = all.filter((b) => b.status === "resolved").length;

  const catRollup = rollupByCategory(all);

  // Trend: most-affected brands (by count) — recurring-issue signal.
  const byBrand = new Map<string | null, number>();
  for (const b of all) byBrand.set(b.brand_id, (byBrand.get(b.brand_id) ?? 0) + 1);
  const brandTrend = Array.from(byBrand.entries())
    .map(([id, n]) => ({ id, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Operations", "Bottlenecks"]} profile={profile}>
      <PageHeader
        title="Bottleneck Monitoring"
        subtitle="Every reported live-session issue, consolidated. Assign one to route it to a department — that creates a tracked task and records the history."
      />
      <LiveOpsTabs />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total" value={all.length} />
        <StatTile label="Open" value={openCount} valueClassName="text-amber-300" />
        <StatTile label="Critical" value={criticalCount} valueClassName="text-red-300" />
        <StatTile label="Resolved" value={resolvedCount} valueClassName="text-teal-300" />
      </div>

      {/* Category rollup + brand trend */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <SectionCard title="By category">
          {catRollup.length === 0 ? (
            <p className="text-xs text-ink-muted">No bottlenecks recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {catRollup.map((c) => (
                <li key={c.category} className="flex items-center justify-between text-xs">
                  <Link href={{ pathname: "/live-ops/bottlenecks", query: { category: c.category } }} className="text-ink hover:text-teal-300">
                    {CATEGORY_LABEL[c.category]}
                  </Link>
                  <span className="flex items-center gap-2 font-mono text-ink-muted">
                    {c.critical > 0 && <Badge tone="red">{c.critical} crit</Badge>}
                    <span className="text-amber-300">{c.open} open</span>
                    <span className="text-ink-dim">/ {c.total}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        <SectionCard title="Most-affected brands" action={<Badge tone="muted">trend</Badge>}>
          {brandTrend.length === 0 ? (
            <p className="text-xs text-ink-muted">No data yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {brandTrend.map((b) => (
                <li key={b.id ?? "none"} className="flex items-center justify-between text-xs">
                  <span className="text-ink">{brandName(b.id)}</span>
                  <span className="font-mono text-ink-muted">{b.n} issue{b.n === 1 ? "" : "s"}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* Filters */}
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Category
          <select name="category" defaultValue={fCat} className={`${inputCls} mt-1 block p-2 text-sm`}>
            <option value="">All</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Brand
          <select name="brand" defaultValue={fBrand} className={`${inputCls} mt-1 block p-2 text-sm`}>
            <option value="">All</option>
            {brands.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Severity
          <select name="severity" defaultValue={fSev} className={`${inputCls} mt-1 block p-2 text-sm`}>
            <option value="">All</option>
            {Object.entries(SEVERITY_LABEL).map(([k, v]) => (<option key={k} value={k}>{v}</option>))}
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Status
          <select name="status" defaultValue={fStatus} className={`${inputCls} mt-1 block p-2 text-sm`}>
            <option value="">All</option>
            {BOTTLENECK_STATUSES.map((s) => (<option key={s} value={s}>{STATUS_LABEL[s]}</option>))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-teal-500 px-3 py-2 text-xs font-semibold text-charcoal-950 hover:bg-teal-400">Apply</button>
        <Link href="/live-ops/bottlenecks" className="rounded-md bg-charcoal-800 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-700">Reset</Link>
      </form>

      {/* Drill-down + assignment */}
      <TableShell columns={["Category", "Brand", "Severity", "Note", "Status", "Assign / route"]}>
        {rows.length === 0 && (
          <tr><td colSpan={6} className="p-4 text-ink-muted">No bottlenecks match these filters.</td></tr>
        )}
        {rows.map((b) => (
          <tr key={b.id} className={rowClass}>
            <td className="p-3">
              <Link href={`/live-ops/reports/${b.session_id}`} className="text-ink hover:text-teal-300">{CATEGORY_LABEL[b.category]}</Link>
              <div className="text-[10px] text-ink-dim">{manilaStamp(b.created_at)}</div>
            </td>
            <td className="p-3 text-ink-muted">{brandName(b.brand_id)}</td>
            <td className="p-3"><Badge tone={SEVERITY_TONE[b.severity]}>{SEVERITY_LABEL[b.severity]}</Badge></td>
            <td className="p-3 max-w-[16rem] truncate text-ink-muted" title={b.note ?? ""}>{b.note ?? "—"}</td>
            <td className="p-3">
              <form action={updateBottleneckStatus} className="flex items-center gap-1.5">
                <input type="hidden" name="id" value={b.id} />
                <select name="status" defaultValue={b.status} className={inputCls}>
                  {BOTTLENECK_STATUSES.map((s) => (<option key={s} value={s}>{STATUS_LABEL[s]}</option>))}
                </select>
                <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-teal-300 hover:bg-charcoal-700">Set</button>
              </form>
              {b.status !== "open" && <div className="mt-1"><Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge></div>}
            </td>
            <td className="p-3">
              {b.task_id ? (
                <span className="text-[11px] text-ink-muted">
                  Routed to <span className="text-ink">{b.assigned_dept ?? "—"}</span> ·{" "}
                  <Link href={`/tasks/${b.task_id}`} className="text-teal-300 hover:text-teal-200">task ↗</Link>
                </span>
              ) : (
                <form action={assignBottleneck} className="flex flex-wrap items-center gap-1.5">
                  <input type="hidden" name="id" value={b.id} />
                  <select name="assigned_dept" defaultValue={b.assigned_dept ?? CATEGORY_DEPARTMENT[b.category]} className={inputCls}>
                    {DEPARTMENTS.map((d) => (<option key={d} value={d}>{d}</option>))}
                  </select>
                  <select name="assigned_to" defaultValue="" className={inputCls}>
                    <option value="">Unassigned</option>
                    {people.map((p) => (<option key={p.id} value={p.id}>{p.full_name}</option>))}
                  </select>
                  <button type="submit" className="rounded-md bg-teal-500 px-2 py-1 text-[11px] font-semibold text-charcoal-950 hover:bg-teal-400">Assign + task</button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </TableShell>
    </AppShell>
  );
}
