import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, Badge, rowClass, type BadgeTone } from "@/components/ui";
import { LiveHeader } from "@/components/metrics/LiveHeader";
import { ElapsedTime } from "@/components/live/ElapsedTime";
import { DemographicsChart } from "@/components/live/DemographicsChart";
import { GoLiveCapture } from "@/components/live/GoLiveCapture";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { customWindow, manilaStamp } from "@/lib/metrics/windows";
import { peso, pesoOrDash, intOrDash } from "@/lib/metrics/format";
import {
  aggregateLive,
  inWindow,
  rollupDemographics,
  scoreAnchors,
  topAnchorsByGmv,
  elapsedSeconds,
  sessionHours,
  sessionCtr,
  ratePct,
  hoursOrDash,
  type Anchor,
  type LiveSession,
} from "@/lib/metrics/live";
import {
  createAnchor,
  updateAnchor,
  deleteAnchor,
  createSession,
  updateLiveMetrics,
  setSessionStatus,
  startLive,
  deleteSession,
} from "./actions";
import { AddAnchorForm } from "./AddAnchorForm";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Live Selling — TikTok Shop LIVE analytics per brand and per anchor.
//
// One org/RLS-scoped surface for the whole live-selling motion: a real-time
// "LIVE NOW" strip, window-aware brand and anchor dashboards, a filterable
// session log, and the anchor registry. Every figure is a real number from
// live_sessions / anchors (source='manual' for now; the API path is reserved
// for the TikTok Live Data scope). Nothing is fabricated — an unrecorded metric
// reads as an honest em-dash and empty sections say so plainly.

export const dynamic = "force-dynamic";

const SESSION_STATUSES = ["scheduled", "live", "ended"] as const;
const SESSION_STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  live: "Live",
  ended: "Ended",
};
const SESSION_STATUS_TONE: Record<string, BadgeTone> = {
  scheduled: "violet",
  live: "red",
  ended: "muted",
};

const ANCHOR_TYPES = ["inhouse", "affiliate"] as const;
const ANCHOR_TYPE_LABEL: Record<string, string> = { inhouse: "In-house", affiliate: "Affiliate" };
const ANCHOR_STATUSES = ["active", "inactive"] as const;
const ANCHOR_STATUS_LABEL: Record<string, string> = { active: "Active", inactive: "Inactive" };

const PLATFORMS = [
  { value: "tiktok_shop", label: "TikTok Shop" },
  { value: "tiktok", label: "TikTok" },
  { value: "shopee", label: "Shopee" },
  { value: "lazada", label: "Lazada" },
];
const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(PLATFORMS.map((p) => [p.value, p.label]));

const fieldCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-xs text-ink";
const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

type Brand = { id: string; name: string };
type Creator = { id: string; name: string };

interface SearchParams extends DateRangeSearchParams {
  brand?: string;
  anchor?: string;
  status?: string;
  archived?: string;
}

export default async function LivePage({ searchParams }: { searchParams?: SearchParams }) {
  const profile = await requireModule("/live");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  // Resolve the active window through the SHARED date-range control the other
  // date-filtered tabs use, so Live Selling picks ranges the same way (and the
  // same URL scheme + custom picker). Defaults to month-to-date, matching the
  // primary dashboards. The concrete [start, end] becomes a custom window so the
  // existing inWindow() filtering — which attributes each session by its own
  // started_at (falling back to created_at) — runs unchanged.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const win = customWindow(dr.range.start, dr.range.end, dr.rangeLabel);

  const brandFilter = searchParams?.brand || "";
  const anchorFilter = searchParams?.anchor || "";
  const statusFilter = SESSION_STATUSES.includes((searchParams?.status ?? "") as never)
    ? searchParams!.status!
    : "";

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();

  const archived = searchParams?.archived === "1";
  const anchorsQuery = u.from("anchors").select("*").order("created_at", { ascending: false });
  const [anchorsRes, sessionsRes, brandsRes, creatorsRes] = await Promise.all([
    archived ? anchorsQuery.not("archived_at", "is", null) : anchorsQuery.is("archived_at", null),
    u.from("live_sessions").select("*").order("started_at", { ascending: false, nullsFirst: false }),
    supabase.from("brands").select("id, name").order("name"),
    u.from("creators").select("id, name").order("name"),
  ]);

  const anchors = (anchorsRes.data ?? []) as Anchor[];
  const allSessions = (sessionsRes.data ?? []) as LiveSession[];
  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const creators = (creatorsRes.data ?? []) as Creator[];

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const anchorName = (id: string | null) => anchors.find((a) => a.id === id)?.name ?? "—";
  const creatorName = (id: string | null) => creators.find((c) => c.id === id)?.name ?? "—";

  // ── Filtering ──────────────────────────────────────────────────────────────
  const passBrand = (s: LiveSession) => !brandFilter || s.brand_id === brandFilter;
  const passAnchor = (s: LiveSession) => !anchorFilter || s.anchor_id === anchorFilter;
  const passStatus = (s: LiveSession) => !statusFilter || s.status === statusFilter;

  // Windowed base for every dashboard figure (attributed by Manila start day).
  const windowed = allSessions.filter((s) => inWindow(s, win));
  // The fully-filtered set drives the KPI row, sessions list and overall demographics.
  const filtered = windowed.filter((s) => passBrand(s) && passAnchor(s) && passStatus(s));

  // LIVE NOW is real-time — it ignores the window and status filter but still
  // honours an explicit brand/anchor filter so a focused view stays focused.
  const liveNow = allSessions.filter((s) => s.status === "live" && passBrand(s) && passAnchor(s));

  // Upcoming lives — sessions scheduled (here or from the Plan calendar; they are
  // the same live_sessions rows). Ignores the window/status filter but honours an
  // explicit brand/anchor filter. Ordered by planned start, soonest first; rows
  // with no planned start sink to the end.
  const upcoming = allSessions
    .filter((s) => s.status === "scheduled" && passBrand(s) && passAnchor(s))
    .sort((a, b) => {
      if (!a.started_at) return 1;
      if (!b.started_at) return -1;
      return a.started_at.localeCompare(b.started_at);
    });

  const overall = aggregateLive(filtered);
  const overallDemo = rollupDemographics(filtered);

  // Per-brand dashboard: every brand (or the filtered one), aggregated over the
  // windowed sessions that pass the anchor/status filter.
  const brandsToShow = brandFilter ? brands.filter((b) => b.id === brandFilter) : brands;
  const brandBase = windowed.filter((s) => passAnchor(s) && passStatus(s));

  // Per-anchor scorecard, ranked by GMV/hour, over the windowed sessions that
  // pass the brand/status filter.
  const anchorBase = windowed.filter((s) => passBrand(s) && passStatus(s));
  const anchorsToShow = anchorFilter ? anchors.filter((a) => a.id === anchorFilter) : anchors;
  const scores = scoreAnchors(anchorsToShow, anchorBase);

  const canManage = true; // all four allowed roles manage this ops surface

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Selling"]} profile={profile}>
      <PageHeader
        title="Live Selling"
        subtitle="TikTok Shop LIVE analytics — per brand and per anchor. Real sessions only; sections stay empty until a session is logged."
      />

      {/* Shared date-range control (URL-persisted, survives refresh). Brand and
          Compare are hidden — this tab keeps its own brand/anchor/status filter
          form below, and per-session metrics aren't a comparison read. */}
      <DateRangeControls {...dr.controlProps} brands={brands} showBrand={false} showCompare={false} />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
          Window · {win.label}
        </p>
        <LiveHeader nowIso={nowIso} freshness={null} freshnessSource={null} progress={null} pace={null} />
      </div>

      {/* ── One-tap capture (PR 6) — go live in a single tap, mobile-first ──── */}
      <GoLiveCapture action={startLive} anchors={anchors} brands={brands} />

      {/* ── LIVE NOW strip ──────────────────────────────────────────────────── */}
      <section className="mb-8">
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden className="relative flex h-2.5 w-2.5">
            {liveNow.length > 0 && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${liveNow.length > 0 ? "bg-red-500" : "bg-ink-dim"}`} />
          </span>
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-muted">Live now</h2>
        </div>
        {liveNow.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">
            No anchors are live right now. Set a session to <span className="text-red-300">Live</span> to see it here with a ticking timer.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {liveNow.map((s) => {
              const seed = elapsedSeconds(s, nowMs) ?? 0;
              return (
                <div
                  key={s.id}
                  className="group rounded-xl border border-red-500/40 bg-red-500/[0.06] p-4 shadow-elevate transition hover:border-red-400/70"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/50 bg-red-500/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-red-300">
                      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" /> Live
                    </span>
                    {s.started_at && (
                      <ElapsedTime startedAt={s.started_at} seedSeconds={seed} className="text-sm text-ink" />
                    )}
                  </div>
                  <Link href={`/live/${s.id}`} className="block">
                    <p className="truncate text-sm font-semibold text-ink hover:text-teal-300">{s.title ?? "Untitled live"}</p>
                    <p className="mt-0.5 truncate text-xs text-ink-muted">
                      {brandName(s.brand_id)} · {anchorName(s.anchor_id)}
                    </p>
                  </Link>

                  {/* Real-time-via-human: update the running metrics in place as the
                      stream goes. Blank clears a metric to unknown (—), never a 0. */}
                  <form action={updateLiveMetrics} className="mt-3 border-t border-red-500/20 pt-3">
                    <input type="hidden" name="id" value={s.id} />
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-[9px] uppercase tracking-wider text-ink-dim">
                        GMV
                        <input name="gmv" type="number" step="any" defaultValue={s.gmv ?? ""} className={`${fieldCls} mt-0.5 w-full`} />
                      </label>
                      <label className="text-[9px] uppercase tracking-wider text-ink-dim">
                        Orders
                        <input name="orders" type="number" defaultValue={s.orders ?? ""} className={`${fieldCls} mt-0.5 w-full`} />
                      </label>
                      <label className="text-[9px] uppercase tracking-wider text-ink-dim">
                        Peak viewers
                        <input name="peak_viewers" type="number" defaultValue={s.peak_viewers ?? ""} className={`${fieldCls} mt-0.5 w-full`} />
                      </label>
                      <label className="text-[9px] uppercase tracking-wider text-ink-dim">
                        Avg viewers
                        <input name="avg_viewers" type="number" defaultValue={s.avg_viewers ?? ""} className={`${fieldCls} mt-0.5 w-full`} />
                      </label>
                    </div>
                    <button type="submit" className="mt-2 w-full rounded-md bg-teal-500 px-2 py-1.5 text-[11px] font-semibold text-charcoal-950 hover:bg-teal-400">
                      Update live metrics
                    </button>
                  </form>

                  <div className="mt-2 flex items-center gap-2">
                    {/* One-tap END LIVE — flips to 'ended' and stamps ended_at now
                        if blank (idempotent, see setSessionStatus). */}
                    <form action={setSessionStatus} className="flex-1">
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="status" value="ended" />
                      <input type="hidden" name="started_at" value={s.started_at ?? ""} />
                      <input type="hidden" name="ended_at" value={s.ended_at ?? ""} />
                      <button type="submit" className="w-full rounded-lg bg-charcoal-800 px-2 py-2.5 text-xs font-bold uppercase tracking-wide text-red-300 hover:bg-charcoal-700">
                        End live
                      </button>
                    </form>
                    <Link href={`/live/${s.id}`} className="rounded-md bg-charcoal-800 px-3 py-1.5 text-[11px] text-ink-muted hover:bg-charcoal-700 hover:text-ink">
                      Open
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Upcoming lives (scheduled) ──────────────────────────────────────── */}
      <section className="mb-8">
        <div className="mb-2 flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-violet-400" />
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-muted">Upcoming lives</h2>
          {upcoming.length > 0 && (
            <Badge tone="violet">{upcoming.length} scheduled</Badge>
          )}
        </div>
        {upcoming.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">
            No lives scheduled. Schedule one below, or plan it on the{" "}
            <Link href="/creative-studio" className="text-teal-300 hover:text-teal-200">content calendar</Link>{" "}
            (Plan tab) — it shows up here as the same session.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((s) => (
              <div
                key={s.id}
                className="group rounded-xl border border-violet-500/30 bg-violet-500/[0.05] p-4 shadow-elevate transition hover:border-violet-400/60"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
                    Scheduled
                  </span>
                  <span className="font-mono text-[11px] text-ink-muted">{manilaStamp(s.started_at) ?? "Start TBD"}</span>
                </div>
                <Link href={`/live/${s.id}`} className="block">
                  <p className="truncate text-sm font-semibold text-ink hover:text-teal-300">{s.title ?? "Untitled live"}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">
                    {brandName(s.brand_id)} · {anchorName(s.anchor_id)}
                  </p>
                </Link>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-dim">
                  <span className="rounded-md border border-charcoal-700 bg-charcoal-950/60 px-1.5 py-0.5 font-mono">
                    {PLATFORM_LABEL[s.platform] ?? s.platform}
                  </span>
                  {s.duration_minutes != null && (
                    <span className="font-mono">~{s.duration_minutes} min planned</span>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-2 border-t border-violet-500/20 pt-3">
                  {/* Start it — flips to 'live' (stamps started_at now if blank), so
                      it moves into LIVE NOW and off this scheduled list. */}
                  <form action={setSessionStatus} className="flex-1">
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="status" value="live" />
                    <input type="hidden" name="started_at" value={s.started_at ?? ""} />
                    <button type="submit" className="w-full rounded-md bg-red-500/90 px-2 py-1.5 text-[11px] font-semibold text-charcoal-950 hover:bg-red-400">
                      Start live
                    </button>
                  </form>
                  <Link href={`/live/${s.id}`} className="rounded-md bg-charcoal-800 px-3 py-1.5 text-[11px] text-ink-muted hover:bg-charcoal-700 hover:text-ink">
                    Edit
                  </Link>
                  <form action={deleteSession}>
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" aria-label="Delete scheduled session" className="rounded-md bg-charcoal-800 px-2 py-1.5 text-[11px] text-red-300 hover:bg-charcoal-700">
                      ✕
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── KPI row (window-aware, respects filters) ────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Live GMV" value={overall.hasMetrics ? peso(overall.gmv) : "—"} hint={`${win.label}`} />
        <StatTile label="Attributed GMV" value={overall.hasMetrics ? peso(overall.attributedGmv) : "—"} hint="attributed to live" />
        <StatTile label="Sessions" value={overall.sessions} hint="in window + filters" />
        <StatTile label="Live hours" value={overall.liveHours > 0 ? hoursOrDash(overall.liveHours) : "—"} hint="from duration / timestamps" />
        <StatTile label="Units sold" value={intOrDash(overall.hasMetrics ? overall.units : null)} />
        <StatTile label="Products sold" value={intOrDash(overall.hasMetrics ? overall.products : null)} />
        <StatTile label="Avg CTR" value={ratePct(overall.ctr)} hint="clicks / impressions" />
        <StatTile label="Avg CTOR" value={ratePct(overall.ctor)} hint="orders / clicks" />
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <form method="get" className="mb-8 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 shadow-elevate">
        {/* Preserve the active date range (owned by the shared control above)
            across this GET submit, so applying a brand/anchor/status filter
            never silently drops the selected window. */}
        <input type="hidden" name="preset" value={dr.preset} />
        {dr.preset === "custom" && (
          <>
            <input type="hidden" name="period_start" value={dr.range.start} />
            <input type="hidden" name="period_end" value={dr.range.end} />
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Brand
            <select name="brand" defaultValue={brandFilter} className={`${fieldCls} mt-1 w-full`}>
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Anchor
            <select name="anchor" defaultValue={anchorFilter} className={`${fieldCls} mt-1 w-full`}>
              <option value="">All anchors</option>
              {anchors.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Status
            <select name="status" defaultValue={statusFilter} className={`${fieldCls} mt-1 w-full`}>
              <option value="">All statuses</option>
              {SESSION_STATUSES.map((s) => (
                <option key={s} value={s}>{SESSION_STATUS_LABEL[s]}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="rounded-md bg-teal-500 px-3 py-2 text-xs font-semibold text-charcoal-950 hover:bg-teal-400">
              Apply
            </button>
            <Link href="/live" className="rounded-md bg-charcoal-800 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-700">
              Reset
            </Link>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-ink-dim">Set the date range with the control at the top of the page. These filters apply to the dashboards and the session log below.</p>
      </form>

      {/* ── Per-brand dashboard ─────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-1 text-lg font-semibold text-ink">
          Per brand <span className="font-mono text-xs text-ink-dim">· {win.label}</span>
        </h2>
        <p className="mb-4 text-sm text-ink-muted">Live GMV, attributed GMV, sessions, live hours, units, avg CTR/CTOR, top anchors and the audience mix for each brand.</p>
        {brandsToShow.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">No clients on file yet.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {brandsToShow.map((b) => {
              const own = brandBase.filter((s) => s.brand_id === b.id);
              const agg = aggregateLive(own);
              const demo = rollupDemographics(own);
              const tops = topAnchorsByGmv(own);
              if (agg.sessions === 0) {
                return (
                  <SectionCard key={b.id} title={b.name}>
                    <p className="text-xs text-ink-muted">No live sessions for this brand in {win.label}.</p>
                  </SectionCard>
                );
              }
              return (
                <SectionCard key={b.id} title={b.name} action={<Badge tone="teal">{agg.sessions} session{agg.sessions === 1 ? "" : "s"}</Badge>}>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "Live GMV", value: agg.hasMetrics ? peso(agg.gmv) : "—", tone: "text-gold-400" },
                      { label: "Attributed", value: agg.hasMetrics ? peso(agg.attributedGmv) : "—" },
                      { label: "Live hours", value: agg.liveHours > 0 ? hoursOrDash(agg.liveHours) : "—" },
                      { label: "Units", value: intOrDash(agg.hasMetrics ? agg.units : null) },
                      { label: "Products", value: intOrDash(agg.hasMetrics ? agg.products : null) },
                      { label: "GMV / hr", value: agg.gmvPerHour != null ? peso(agg.gmvPerHour) : "—" },
                      { label: "Avg CTR", value: ratePct(agg.ctr), tone: "text-teal-300" },
                      { label: "Avg CTOR", value: ratePct(agg.ctor), tone: "text-violet-300" },
                      { label: "Avg viewers", value: intOrDash(agg.avgViewers) },
                    ].map((c) => (
                      <div key={c.label} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-2">
                        <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{c.label}</p>
                        <p className={`mt-0.5 font-mono text-xs ${c.tone ?? "text-ink"}`}>{c.value}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4">
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Top anchors (GMV)</p>
                    {tops.length === 0 ? (
                      <p className="text-xs text-ink-muted">No anchor-attributed sessions yet.</p>
                    ) : (
                      <ul className="space-y-1">
                        {tops.map((t) => (
                          <li key={t.anchorId} className="flex items-center justify-between text-xs">
                            <span className="truncate text-ink">{anchorName(t.anchorId)}</span>
                            <span className="font-mono text-ink-muted">{peso(t.gmv)} · {t.sessions} live</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="mt-4 border-t border-charcoal-700/60 pt-4">
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Audience mix</p>
                    <DemographicsChart rollup={demo} />
                  </div>
                </SectionCard>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Per-anchor scorecard ────────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-1 text-lg font-semibold text-ink">
          Per anchor <span className="font-mono text-xs text-ink-dim">· ranked by GMV / hour · {win.label}</span>
        </h2>
        <p className="mb-4 text-sm text-ink-muted">Each anchor's sessions with timestamps, live hours, GMV, units, CTR/CTOR, attributed GMV and average viewers.</p>
        <TableShell
          columns={["Anchor", "Type", "Sessions", "w/ timestamps", "Live hrs", "GMV", "GMV/hr", "Attr GMV", "Units", "CTR", "CTOR", "Avg viewers"]}
        >
          {scores.filter((s) => s.agg.sessions > 0).length === 0 && (
            <tr>
              <td colSpan={12} className="p-4 text-ink-muted">No anchor sessions in {win.label} for the current filters.</td>
            </tr>
          )}
          {scores
            .filter((s) => s.agg.sessions > 0)
            .map(({ anchor, agg, withTimestamps }) => (
              <tr key={anchor.id} className={rowClass}>
                <td className="p-3">
                  <Link href={{ pathname: "/live", query: { anchor: anchor.id } }} className="text-ink hover:text-teal-300">
                    {anchor.name}
                  </Link>
                  {anchor.handle ? <span className="text-ink-muted"> · {anchor.handle}</span> : ""}
                </td>
                <td className="p-3 text-ink-muted">{ANCHOR_TYPE_LABEL[anchor.anchor_type] ?? anchor.anchor_type}</td>
                <td className="p-3 font-mono text-ink">{agg.sessions}</td>
                <td className="p-3 font-mono text-ink-muted">{withTimestamps}</td>
                <td className="p-3 font-mono text-ink">{agg.liveHours > 0 ? hoursOrDash(agg.liveHours) : "—"}</td>
                <td className="p-3 font-mono text-gold-400">{agg.hasMetrics ? peso(agg.gmv) : "—"}</td>
                <td className="p-3 font-mono text-green-400">{agg.gmvPerHour != null ? peso(agg.gmvPerHour) : "—"}</td>
                <td className="p-3 font-mono text-ink">{agg.hasMetrics ? peso(agg.attributedGmv) : "—"}</td>
                <td className="p-3 font-mono text-ink">{intOrDash(agg.hasMetrics ? agg.units : null)}</td>
                <td className="p-3 font-mono text-teal-300">{ratePct(agg.ctr)}</td>
                <td className="p-3 font-mono text-violet-300">{ratePct(agg.ctor)}</td>
                <td className="p-3 font-mono text-ink-muted">{intOrDash(agg.avgViewers)}</td>
              </tr>
            ))}
        </TableShell>
      </section>

      {/* ── Per-brand session log (filtered list + running totals) ──────────── */}
      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold text-ink">
          Session log
          <span className="font-mono text-xs text-ink-dim"> · {brandFilter ? brandName(brandFilter) : "all brands"} · {win.label}</span>
        </h2>
        <p className="mb-4 text-sm text-ink-muted">Every logged session for the selected brand in {win.label}, most recent first. Blank metrics read as an honest “—”. Open a session for its funnel, demographics and full editor.</p>
        {(() => {
          // Running totals for the selected window — real rows only. Each total is
          // shown as “—” unless at least one session actually recorded that metric,
          // so a table of untracked sessions never implies a real zero.
          const anyGmv = filtered.some((s) => s.gmv != null);
          const anyOrders = filtered.some((s) => s.orders != null);
          const anyUnits = filtered.some((s) => s.units_sold != null);
          const peakVals = filtered
            .map((s) => s.peak_viewers)
            .filter((v): v is number => v != null);
          const avgPeak = peakVals.length
            ? Math.round(peakVals.reduce((a, b) => a + b, 0) / peakVals.length)
            : null;
          return (
            <TableShell
              columns={["Session", "Date", "Host", "Platform", "Duration", "GMV", "Orders", "Units", "Peak", "CTR", "Status", "Actions"]}
            >
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={12} className="p-4 text-ink-muted">No sessions match the current window and filters.</td>
                </tr>
              )}
              {filtered.map((s) => {
                const ctr = sessionCtr(s).value;
                const hrs = sessionHours(s);
                return (
                  <tr key={s.id} className={rowClass}>
                    <td className="p-3">
                      <Link href={`/live/${s.id}`} className="text-ink hover:text-teal-300">
                        {s.title ?? "Untitled live"}
                      </Link>
                    </td>
                    <td className="p-3 text-[11px] text-ink-dim">{manilaStamp(s.started_at) ?? "—"}</td>
                    <td className="p-3 text-ink-muted">{anchorName(s.anchor_id)}</td>
                    <td className="p-3 text-ink-muted">{PLATFORM_LABEL[s.platform] ?? s.platform}</td>
                    <td className="p-3 font-mono text-ink">{hoursOrDash(hrs)}</td>
                    <td className="p-3 font-mono text-gold-400">{pesoOrDash(s.gmv)}</td>
                    <td className="p-3 font-mono text-ink">{intOrDash(s.orders)}</td>
                    <td className="p-3 font-mono text-ink">{intOrDash(s.units_sold)}</td>
                    <td className="p-3 font-mono text-ink-muted">{intOrDash(s.peak_viewers)}</td>
                    <td className="p-3 font-mono text-teal-300">{ratePct(ctr)}</td>
                    <td className="p-3">
                      {canManage ? (
                        <form action={setSessionStatus} className="flex items-center gap-1.5">
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="started_at" value={s.started_at ?? ""} />
                          <input type="hidden" name="ended_at" value={s.ended_at ?? ""} />
                          <select name="status" defaultValue={s.status} className={`${fieldCls} py-1`}>
                            {SESSION_STATUSES.map((st) => (
                              <option key={st} value={st}>{SESSION_STATUS_LABEL[st]}</option>
                            ))}
                          </select>
                          <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-teal-300 hover:bg-charcoal-700">Set</button>
                        </form>
                      ) : (
                        <Badge tone={SESSION_STATUS_TONE[s.status] ?? "muted"}>{SESSION_STATUS_LABEL[s.status] ?? s.status}</Badge>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <Link href={`/live/${s.id}`} className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-ink-muted hover:bg-charcoal-700 hover:text-ink">Open</Link>
                        <form action={deleteSession}>
                          <input type="hidden" name="id" value={s.id} />
                          <button type="submit" aria-label="Delete session" className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-red-300 hover:bg-charcoal-700">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length > 0 && (
                <tr className="border-t-2 border-charcoal-600 bg-charcoal-950/40 font-mono text-xs">
                  <td className="p-3 text-ink" colSpan={5}>
                    Totals · {filtered.length} session{filtered.length === 1 ? "" : "s"}
                  </td>
                  <td className="p-3 text-gold-400">{anyGmv ? peso(overall.gmv) : "—"}</td>
                  <td className="p-3 text-ink">{intOrDash(anyOrders ? overall.orders : null)}</td>
                  <td className="p-3 text-ink">{intOrDash(anyUnits ? overall.units : null)}</td>
                  <td className="p-3 text-ink-muted" title="Average peak viewers across sessions">{intOrDash(avgPeak)}</td>
                  <td className="p-3" colSpan={3}></td>
                </tr>
              )}
            </TableShell>
          );
        })()}
      </section>

      {/* ── Log a session ───────────────────────────────────────────────────── */}
      <SectionCard title="Log a live session" className="mb-8">
        <p className="mb-3 text-xs text-ink-muted">
          Record a session and its results. Leave a metric blank when it's unknown — it stays empty rather than showing a fabricated zero. Demographics take
          <span className="text-ink"> bucket:weight</span> pairs, e.g. <span className="font-mono text-ink">18-24:30, 25-34:45</span>.
        </p>
        <form action={createSession} className="grid gap-3 sm:grid-cols-3">
          <input name="title" placeholder="Session title" className={`${inputCls} sm:col-span-3`} />
          <select name="brand_id" defaultValue="" className={inputCls}>
            <option value="">Brand…</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select name="anchor_id" defaultValue="" className={inputCls}>
            <option value="">Anchor…</option>
            {anchors.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <select name="platform" defaultValue="tiktok_shop" className={inputCls}>
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <select name="status" defaultValue="scheduled" className={inputCls}>
            {SESSION_STATUSES.map((s) => (
              <option key={s} value={s}>{SESSION_STATUS_LABEL[s]}</option>
            ))}
          </select>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Started
            <input type="datetime-local" name="started_at" className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Ended
            <input type="datetime-local" name="ended_at" className={`${inputCls} mt-1 w-full`} />
          </label>
          <input name="duration_minutes" type="number" step="any" placeholder="Duration (min)" className={inputCls} />
          <input name="gmv" type="number" step="any" placeholder="GMV" className={inputCls} />
          <input name="attributed_gmv" type="number" step="any" placeholder="Attributed GMV" className={inputCls} />
          <input name="units_sold" type="number" placeholder="Units sold" className={inputCls} />
          <input name="products_sold" type="number" placeholder="Products sold" className={inputCls} />
          <input name="impressions" type="number" placeholder="Impressions" className={inputCls} />
          <input name="clicks" type="number" placeholder="Clicks" className={inputCls} />
          <input name="orders" type="number" placeholder="Orders" className={inputCls} />
          <input name="ctr" type="number" step="any" placeholder="CTR (if no counts)" className={inputCls} />
          <input name="ctor" type="number" step="any" placeholder="CTOR (if no counts)" className={inputCls} />
          <input name="peak_viewers" type="number" placeholder="Peak viewers" className={inputCls} />
          <input name="avg_viewers" type="number" placeholder="Avg viewers" className={inputCls} />
          <input name="demo_age" placeholder="Age e.g. 18-24:30, 25-34:45" className={`${inputCls} sm:col-span-3`} />
          <input name="demo_gender" placeholder="Gender e.g. female:70, male:30" className={`${inputCls} sm:col-span-3`} />
          <input name="demo_location" placeholder="Location e.g. Manila:40, Cebu:20" className={`${inputCls} sm:col-span-3`} />
          <input name="notes" placeholder="Notes (optional)" className={`${inputCls} sm:col-span-3`} />
          <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-3">
            Log session
          </button>
        </form>
      </SectionCard>

      {/* ── Anchor registry ─────────────────────────────────────────────────── */}
      <section className="mb-8">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-ink">Anchors</h2>
          <ArchivedToggle
            basePath="/live"
            archived={archived}
            params={{
              ...(brandFilter ? { brand: brandFilter } : {}),
              ...(anchorFilter ? { anchor: anchorFilter } : {}),
              ...(statusFilter ? { status: statusFilter } : {}),
              ...(dr.preset ? { preset: dr.preset } : {}),
              ...(dr.preset === "custom"
                ? { period_start: dr.range.start, period_end: dr.range.end }
                : {}),
            }}
          />
        </div>
        <p className="mb-4 text-sm text-ink-muted">Your registered live hosts. In-house or affiliate (link the creator record for affiliates), with their handle, platform and status.</p>

        <AddAnchorForm
          action={createAnchor}
          platforms={[
            { value: "tiktok", label: "TikTok" },
            { value: "shopee", label: "Shopee" },
            { value: "instagram", label: "Instagram" },
            { value: "facebook", label: "Facebook" },
            { value: "youtube", label: "YouTube" },
          ]}
          anchorTypes={ANCHOR_TYPES.map((t) => ({ value: t, label: ANCHOR_TYPE_LABEL[t] }))}
          creators={creators}
        />

        <TableShell columns={["Anchor", "Platform", "Type", "Creator", "Status", "Actions", "Manage"]}>
          {anchors.length === 0 && (
            <tr>
              <td colSpan={7} className="p-4 text-ink-muted">No anchors registered yet — add your first host above.</td>
            </tr>
          )}
          {anchors.map((a) => (
            <tr key={a.id} className={rowClass}>
              <td className="p-3">
                <span className="text-ink">{a.name}</span>
                {a.handle ? <span className="text-ink-muted"> · {a.handle}</span> : ""}
              </td>
              <td className="p-3 text-ink-muted">{PLATFORM_LABEL[a.platform] ?? a.platform}</td>
              <td className="p-3">
                <Badge tone={a.anchor_type === "affiliate" ? "violet" : "teal"}>
                  {ANCHOR_TYPE_LABEL[a.anchor_type] ?? a.anchor_type}
                </Badge>
              </td>
              <td className="p-3 text-ink-muted">{a.anchor_type === "affiliate" ? creatorName(a.creator_id) : "—"}</td>
              <td className="p-3">
                <form action={updateAnchor} className="flex flex-wrap items-center gap-1.5">
                  <input type="hidden" name="id" value={a.id} />
                  <select name="status" defaultValue={a.status} className={`${fieldCls} py-1`}>
                    {ANCHOR_STATUSES.map((s) => (
                      <option key={s} value={s}>{ANCHOR_STATUS_LABEL[s]}</option>
                    ))}
                  </select>
                  <select name="anchor_type" defaultValue={a.anchor_type} className={`${fieldCls} py-1`}>
                    {ANCHOR_TYPES.map((t) => (
                      <option key={t} value={t}>{ANCHOR_TYPE_LABEL[t]}</option>
                    ))}
                  </select>
                  <select name="creator_id" defaultValue={a.creator_id ?? ""} className={`${fieldCls} py-1`}>
                    <option value="">No creator</option>
                    {creators.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-teal-300 hover:bg-charcoal-700">Save</button>
                </form>
              </td>
              <td className="p-3">
                <form action={deleteAnchor}>
                  <input type="hidden" name="id" value={a.id} />
                  <button type="submit" aria-label="Delete anchor" className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-red-300 hover:bg-charcoal-700">Delete</button>
                </form>
              </td>
              <td className="p-3">
                <RowActions {...rowActionProps("anchors", a as unknown as Record<string, unknown>, profile)} />
              </td>
            </tr>
          ))}
        </TableShell>
      </section>
    </AppShell>
  );
}
