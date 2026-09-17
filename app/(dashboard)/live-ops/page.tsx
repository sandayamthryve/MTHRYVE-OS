import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, Badge, rowClass } from "@/components/ui";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import { LiveOpsTabs } from "@/components/live-ops/LiveOpsTabs";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { customWindow } from "@/lib/metrics/windows";
import { peso, pesoOrDash, intOrDash, pctOrDash } from "@/lib/metrics/format";
import { inWindow, hoursOrDash, manilaDateOf, type LiveSession } from "@/lib/metrics/live";
import { deriveLiveOps } from "@/lib/live-ops/derive";

// PART B — Live Performance dashboard.
//
// Every card DERIVES from live_sessions (One home per fact): the module never
// re-encodes a live metric into metric_entries. Cards refresh on brand + date
// window. Honest nulls throughout — a metric no session recorded reads "—",
// never 0.

export const dynamic = "force-dynamic";

type Brand = { id: string; name: string };

// A tiny CSS bar-trend: one bar per day, height ∝ value. Honest — days with no
// value render an empty track, and the whole strip is omitted when there's no
// data at all (handled by the caller).
function BarTrend({ points, color }: { points: { label: string; value: number | null }[]; color: string }) {
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  return (
    <div className="flex items-end gap-1" style={{ height: 96 }}>
      {points.map((p, i) => {
        const h = p.value != null ? Math.max(2, Math.round((p.value / max) * 92)) : 0;
        return (
          <div key={i} className="flex flex-1 flex-col items-center justify-end" title={`${p.label}: ${p.value ?? "—"}`}>
            <div
              className="w-full rounded-t"
              style={{ height: h, backgroundColor: p.value != null ? color : "transparent", minWidth: 3 }}
            />
            <span className="mt-1 font-mono text-[8px] text-ink-dim">{p.label.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default async function LiveOpsDashboard({
  searchParams,
}: {
  searchParams?: DateRangeSearchParams;
}) {
  const profile = await requireModule("/live-ops");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  // Shared date-range control (defaults to last 30 days). Every card is derived
  // from live_sessions inside the selected window + brand. Compare isn't wired
  // here (metrics are per-session derived), so the picker hides that lever.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "last_30" });
  const win = customWindow(dr.range.start, dr.range.end, dr.rangeLabel);
  const brandFilter = dr.brandId ?? "";

  const [sessionsRes, brandsRes] = await Promise.all([
    u.from("live_sessions").select("*").order("started_at", { ascending: false, nullsFirst: false }),
    supabase.from("brands").select("id, name").order("name"),
  ]);
  const allSessions = (sessionsRes.data ?? []) as LiveSession[];
  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";

  // Windowed + brand-filtered base for every card. (Ended/logged sessions only
  // contribute their recorded metrics; the derive layer treats nulls honestly.)
  const windowed = allSessions.filter((s) => inWindow(s, win));
  const filtered = windowed.filter((s) => !brandFilter || s.brand_id === brandFilter);
  const d = deriveLiveOps(filtered);

  // Per-day trend (GMV) across the window.
  const byDay = new Map<string, { gmv: number; orders: number; sessions: number }>();
  for (const s of filtered) {
    const day = manilaDateOf(s.started_at) ?? manilaDateOf(s.created_at);
    if (!day) continue;
    const cur = byDay.get(day) ?? { gmv: 0, orders: 0, sessions: 0 };
    if (s.gmv != null) cur.gmv += Number(s.gmv);
    if (s.orders != null) cur.orders += Number(s.orders);
    cur.sessions += 1;
    byDay.set(day, cur);
  }
  const trendDays = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ label: day, value: v.sessions > 0 ? v.gmv : null }));

  // Brand comparison over the window (all brands, ignoring the brand filter).
  const brandRows = brands
    .map((b) => {
      const own = windowed.filter((s) => s.brand_id === b.id);
      return { brand: b, d: deriveLiveOps(own) };
    })
    .filter((r) => r.d.sessionCount > 0)
    .sort((a, b) => (b.d.gmv ?? 0) - (a.d.gmv ?? 0));

  // Weekday heatmap of GMV — six-tone intensity, honest empty cells.
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayGmv = new Array(7).fill(null) as (number | null)[];
  for (const s of filtered) {
    const day = manilaDateOf(s.started_at) ?? manilaDateOf(s.created_at);
    if (!day || s.gmv == null) continue;
    // Noon Manila (04:00 UTC) resolves to the same calendar date in UTC, so the
    // weekday index 0..6 is stable regardless of server timezone.
    const idx = new Date(`${day}T12:00:00+08:00`).getUTCDay();
    weekdayGmv[idx] = (weekdayGmv[idx] ?? 0) + Number(s.gmv);
  }
  const heatMax = Math.max(1, ...weekdayGmv.map((v) => v ?? 0));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Operations"]} profile={profile}>
      <PageHeader
        title="Live Operations"
        subtitle="Live Performance — every card is derived from real live sessions. Blank metrics read as an honest “—”, never a fabricated 0."
      />
      <LiveOpsTabs />

      {/* Shared date-range + brand control — persisted in the URL (survives
          refresh). Every card below re-derives on the selected window + brand. */}
      <DateRangeControls {...dr.controlProps} brands={brands} showCompare={false} />

      <p className="mb-4 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
        Window · {win.label} · {brandFilter ? brandName(brandFilter) : "all brands"} · {d.sessionCount} session{d.sessionCount === 1 ? "" : "s"}
      </p>

      {/* ── Sales ── */}
      <SectionCard title="Sales" className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="GMV" value={pesoOrDash(d.gmv)} valueClassName="text-gold-400" />
          <StatTile label="Total sales" value={pesoOrDash(d.totalSales)} />
          <StatTile label="Orders" value={intOrDash(d.orders)} />
          <StatTile label="AOV" value={pesoOrDash(d.aov)} hint="GMV / orders" />
          <StatTile label="Conversion" value={pctOrDash(d.conversion, 1)} hint="orders / clicks" />
        </div>
      </SectionCard>

      {/* ── Audience ── */}
      <SectionCard title="Audience" className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Impressions" value={intOrDash(d.impressions)} />
          <StatTile label="Viewers" value={intOrDash(d.viewers)} />
          <StatTile label="Peak viewers" value={intOrDash(d.peakViewers)} />
          <StatTile label="Avg viewers" value={intOrDash(d.avgViewers)} />
          <StatTile label="Viewer retention" value={pctOrDash(d.viewerRetention, 1)} />
        </div>
      </SectionCard>

      {/* ── Engagement ── */}
      <SectionCard title="Engagement" className="mb-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <StatTile label="Product clicks" value={intOrDash(d.productClicks)} />
          <StatTile label="CTR" value={pctOrDash(d.ctr, 2)} valueClassName="text-teal-300" />
          <StatTile label="Likes" value={intOrDash(d.likes)} />
          <StatTile label="Shares" value={intOrDash(d.shares)} />
          <StatTile label="Comments" value={intOrDash(d.comments)} />
          <StatTile label="Engagement" value={pctOrDash(d.engagementRate, 1)} />
          <StatTile label="New followers" value={intOrDash(d.newFollowers)} />
          <StatTile label="Returning" value={intOrDash(d.returningViewers)} />
        </div>
      </SectionCard>

      {/* ── Live Session ── */}
      <SectionCard title="Live Session" className="mb-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Sessions" value={d.sessionCount} />
          <StatTile label="Total live hours" value={hoursOrDash(d.totalLiveHours)} hint="from start/end" />
          <StatTile label="Avg duration" value={d.avgDurationMinutes != null ? `${Math.round(d.avgDurationMinutes)}m` : "—"} />
          <StatTile label="Active anchors" value={d.activeAnchors || "—"} />
          <StatTile label="Best session" value={d.bestSession ? peso(d.bestSession.gmv) : "—"} hint={d.bestSession?.title ?? undefined} />
          <StatTile label="Best product" value={d.bestProduct ?? "—"} valueClassName="text-sm" />
        </div>
      </SectionCard>

      {/* ── Charts row: trend + heatmap ── */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <SectionCard title="GMV trend" action={<Badge tone="muted">{win.label}</Badge>}>
          {trendDays.length === 0 ? (
            <p className="text-xs text-ink-muted">No sessions with a date in this window.</p>
          ) : (
            <BarTrend points={trendDays} color="#e0b64a" />
          )}
        </SectionCard>

        <SectionCard title="GMV by weekday" action={<Badge tone="muted">heat map</Badge>}>
          <div className="grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((wd, i) => {
              const v = weekdayGmv[i];
              const intensity = v != null ? 0.12 + (v / heatMax) * 0.78 : 0;
              return (
                <div key={wd} className="text-center">
                  <div
                    className="flex h-14 items-center justify-center rounded-md border border-charcoal-700/60 font-mono text-[10px] text-ink"
                    style={{ backgroundColor: v != null ? `rgba(224,182,74,${intensity})` : "transparent" }}
                    title={v != null ? peso(v) : "—"}
                  >
                    {v != null ? "" : "—"}
                  </div>
                  <span className="mt-1 block font-mono text-[9px] uppercase tracking-wider text-ink-dim">{wd}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-ink-dim">Cell shade ∝ GMV; an empty cell is an honest “—”.</p>
        </SectionCard>
      </div>

      {/* ── Brand comparison ── */}
      <SectionCard title="Brand comparison" action={<Badge tone="muted">{win.label}</Badge>}>
        <TableShell columns={["Brand", "Sessions", "Live hrs", "GMV", "Orders", "AOV", "Peak viewers", "Engagement"]}>
          {brandRows.length === 0 && (
            <tr>
              <td colSpan={8} className="p-4 text-ink-muted">No brand had a live session in this window.</td>
            </tr>
          )}
          {brandRows.map(({ brand, d: bd }) => (
            <tr key={brand.id} className={rowClass}>
              <td className="p-3">
                <Link href={{ pathname: "/live-ops", query: { brand_id: brand.id } }} className="text-ink hover:text-teal-300">{brand.name}</Link>
              </td>
              <td className="p-3 font-mono text-ink">{bd.sessionCount}</td>
              <td className="p-3 font-mono text-ink">{hoursOrDash(bd.totalLiveHours)}</td>
              <td className="p-3 font-mono text-gold-400">{pesoOrDash(bd.gmv)}</td>
              <td className="p-3 font-mono text-ink">{intOrDash(bd.orders)}</td>
              <td className="p-3 font-mono text-ink">{pesoOrDash(bd.aov)}</td>
              <td className="p-3 font-mono text-ink-muted">{intOrDash(bd.peakViewers)}</td>
              <td className="p-3 font-mono text-teal-300">{pctOrDash(bd.engagementRate, 1)}</td>
            </tr>
          ))}
        </TableShell>
      </SectionCard>
    </AppShell>
  );
}
