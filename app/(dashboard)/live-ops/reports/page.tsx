import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, Badge, rowClass, type BadgeTone } from "@/components/ui";
import { LiveOpsTabs } from "@/components/live-ops/LiveOpsTabs";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manilaStamp } from "@/lib/metrics/windows";
import { pesoOrDash, intOrDash } from "@/lib/metrics/format";
import { hoursOrDash, sessionHours, type LiveSession } from "@/lib/metrics/live";
import { createLiveReport } from "../actions";

// PART C — Daily Live Report Logs (list + new report).
//
// One report = one live_sessions row. The list shows lifecycle status
// (draft → submitted → reviewed), Total Live Hours (computed from start/end)
// and the headline metrics. Creating a report opens its editor.

export const dynamic = "force-dynamic";

type Brand = { id: string; name: string };
type Anchor = { id: string; name: string };
type Person = { id: string; full_name: string };

const REPORT_STATUS_TONE: Record<string, BadgeTone> = {
  draft: "muted",
  submitted: "violet",
  reviewed: "teal",
};
const REPORT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  reviewed: "Reviewed",
};

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

interface SearchParams { status?: string; brand?: string; archived?: string }

export default async function LiveReportsPage({ searchParams }: { searchParams?: SearchParams }) {
  const profile = await requireModule("/live-ops");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const archived = searchParams?.archived === "1";
  const sessionsQuery = u
    .from("live_sessions")
    .select("*")
    .order("started_at", { ascending: false, nullsFirst: false });
  const [sessionsRes, brandsRes, anchorsRes, usersRes] = await Promise.all([
    archived ? sessionsQuery.not("archived_at", "is", null) : sessionsQuery.is("archived_at", null),
    supabase.from("brands").select("id, name").order("name"),
    u.from("anchors").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
  ]);

  const allSessions = (sessionsRes.data ?? []) as LiveSession[];
  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const anchors = (anchorsRes.data ?? []) as Anchor[];
  const people = (usersRes.data ?? []) as unknown as Person[];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const anchorName = (id: string | null) => anchors.find((a) => a.id === id)?.name ?? "—";

  const statusFilter = searchParams?.status ?? "";
  const brandFilter = searchParams?.brand ?? "";
  const reports = allSessions.filter(
    (s) => (!statusFilter || s.report_status === statusFilter) && (!brandFilter || s.brand_id === brandFilter)
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Operations", "Daily Reports"]} profile={profile}>
      <PageHeader
        title="Daily Live Reports"
        subtitle="One report per live session. Total Live Hours computes from start/end; every metric is hybrid — auto where the API delivers, otherwise hand-encoded."
      />
      <LiveOpsTabs />

      {/* Filters */}
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Status
          <select name="status" defaultValue={statusFilter} className={`${inputCls} mt-1 block`}>
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="reviewed">Reviewed</option>
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Brand
          <select name="brand" defaultValue={brandFilter} className={`${inputCls} mt-1 block`}>
            <option value="">All brands</option>
            {brands.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
          </select>
        </label>
        <button type="submit" className="rounded-md bg-teal-500 px-3 py-2 text-xs font-semibold text-charcoal-950 hover:bg-teal-400">Apply</button>
        <Link href="/live-ops/reports" className="rounded-md bg-charcoal-800 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-700">Reset</Link>
      </form>

      <div className="mb-4 flex justify-end">
        <ArchivedToggle
          basePath="/live-ops/reports"
          archived={archived}
          params={{
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(brandFilter ? { brand: brandFilter } : {}),
          }}
        />
      </div>

      <TableShell columns={["Session", "Date", "Brand", "Anchor", "Live hrs", "GMV", "Orders", "Report", "Session", "Manage"]}>
        {reports.length === 0 && (
          <tr><td colSpan={10} className="p-4 text-ink-muted">No reports match. Log one below.</td></tr>
        )}
        {reports.map((s) => (
          <tr key={s.id} className={rowClass}>
            <td className="p-3">
              <Link href={`/live-ops/reports/${s.id}`} className="text-ink hover:text-teal-300">
                {s.title ?? "Untitled live"}{s.session_number ? <span className="text-ink-dim"> · #{s.session_number}</span> : null}
              </Link>
            </td>
            <td className="p-3 text-[11px] text-ink-dim">{manilaStamp(s.started_at) ?? "—"}</td>
            <td className="p-3 text-ink-muted">{brandName(s.brand_id)}</td>
            <td className="p-3 text-ink-muted">{anchorName(s.anchor_id)}</td>
            <td className="p-3 font-mono text-ink">{hoursOrDash(sessionHours(s))}</td>
            <td className="p-3 font-mono text-gold-400">{pesoOrDash(s.gmv)}</td>
            <td className="p-3 font-mono text-ink">{intOrDash(s.orders)}</td>
            <td className="p-3"><Badge tone={REPORT_STATUS_TONE[s.report_status] ?? "muted"}>{REPORT_STATUS_LABEL[s.report_status] ?? s.report_status}</Badge></td>
            <td className="p-3"><Badge tone={s.status === "live" ? "red" : s.status === "scheduled" ? "violet" : "muted"}>{s.status}</Badge></td>
            <td className="p-3"><RowActions {...rowActionProps("live_sessions", s as unknown as Record<string, unknown>, profile)} /></td>
          </tr>
        ))}
      </TableShell>

      {/* New report */}
      <SectionCard title="New daily live report" className="mt-8">
        <p className="mb-3 text-xs text-ink-muted">
          Enter the Session Information header — you'll fill the standard metrics and Session Assessment on the next screen. Leave anything unknown blank; it stays “—”, never a fabricated 0.
        </p>
        <form action={createLiveReport} className="grid gap-3 sm:grid-cols-3">
          <input name="title" placeholder="Session title" className={`${inputCls} sm:col-span-2`} />
          <input name="session_number" placeholder="Session # (optional)" className={inputCls} />
          <select name="brand_id" defaultValue="" className={inputCls}>
            <option value="">Brand…</option>
            {brands.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
          </select>
          <select name="anchor_id" defaultValue="" className={inputCls}>
            <option value="">Anchor…</option>
            {anchors.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </select>
          <select name="moderator_id" defaultValue="" className={inputCls}>
            <option value="">Moderator…</option>
            {people.map((p) => (<option key={p.id} value={p.id}>{p.full_name}</option>))}
          </select>
          <select name="team_leader_id" defaultValue="" className={inputCls}>
            <option value="">Team leader…</option>
            {people.map((p) => (<option key={p.id} value={p.id}>{p.full_name}</option>))}
          </select>
          <input name="studio" placeholder="Studio" className={inputCls} />
          <input name="shift" placeholder="Shift (e.g. AM / PM)" className={inputCls} />
          <select name="platform" defaultValue="tiktok_shop" className={inputCls}>
            <option value="tiktok_shop">TikTok Shop</option>
            <option value="tiktok">TikTok</option>
            <option value="shopee">Shopee</option>
            <option value="lazada">Lazada</option>
          </select>
          <select name="status" defaultValue="ended" className={inputCls}>
            <option value="ended">Ended (past live)</option>
            <option value="scheduled">Scheduled</option>
            <option value="live">Live</option>
          </select>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Started
            <input type="datetime-local" name="started_at" className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Ended
            <input type="datetime-local" name="ended_at" className={`${inputCls} mt-1 w-full`} />
          </label>
          <input name="expected_duration_minutes" type="number" placeholder="Expected duration (min)" className={inputCls} />
          <input name="featured_products" placeholder="Featured products" className={`${inputCls} sm:col-span-3`} />
          <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-3">
            Create report
          </button>
        </form>
      </SectionCard>
    </AppShell>
  );
}
