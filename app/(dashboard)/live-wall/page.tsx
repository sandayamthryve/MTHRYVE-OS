import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, Badge, type BadgeTone, HelpHint } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { pesoOrDash, intOrDash, pctOrDash } from "@/lib/metrics/format";
import { ElapsedTime } from "@/components/live/ElapsedTime";
import { LiveEmbed } from "@/components/live-wall/LiveEmbed";
import { VideoPlayer } from "@/components/live-wall/VideoPlayer";
import { AnalyzeButton } from "@/components/live-wall/AnalyzeButton";
import { LiveAutoRefresh } from "@/components/live-wall/LiveAutoRefresh";
import { AddVideoForm } from "@/components/live-wall/AddVideoForm";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import {
  WALL_PLATFORMS,
  SESSION_STATUSES,
  platformLabel,
  statusLabel,
} from "@/lib/live-wall/constants";
import { tileMetricsFromRow, TILE_METRIC_COLUMNS, type LiveSessionMetricRow } from "@/lib/live-wall/metrics";
import {
  createLiveSession,
  updateLiveSession,
  setLiveStatus,
  deleteLiveSession,
  addVideo,
  deleteVideo,
} from "./actions";

// Live & Video Wall — the agency's mission-control multiview.
//
// One page, two surfaces (one clean nav entry):
//   1. LIVE MULTIVIEW — a grid of every live session, all visible at once,
//      filterable BY BRAND and BY PLATFORM. Each tile shows brand + platform +
//      host + status + the session's Live-compartment metrics (viewers / GMV /
//      CTOR). A session with an embeddable embed_url PLAYS inline; a native
//      TikTok / Shopee / Lazada live shows its thumbnail + a "Watch Live"
//      link-out. Leadership + heads add/edit sessions; the grid self-refreshes.
//   2. VIDEO LIBRARY — paste a TikTok / YouTube / MP4 link and it embeds and
//      plays inside the OS through the official player. The whole org watches.
//
// Honest nulls throughout: a metric with no entry reads "—", never a fake figure.
// RLS is the real gate. The whole org OPERATES the wall: reads are org-scoped, and
// live_sessions (org-writable) + videos (org INSERT/UPDATE) let any member add/edit
// a session and post/edit a video — mirrored by the server actions' requireProfile.
// Only the DESTRUCTIVE + AI-spend controls stay leadership (canModerate): hard-delete
// (RLS DELETE on both tables is ceo/coo/department_head) and Tony's Analyze (files a
// leadership-only action_request). Members never see a control that would 403.

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, BadgeTone> = {
  scheduled: "violet",
  live: "red",
  ended: "muted",
};
// Live first, then scheduled, then ended.
const STATUS_RANK: Record<string, number> = { live: 0, scheduled: 1, ended: 2 };

const fieldCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-xs text-ink";
const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

interface SessionRow extends LiveSessionMetricRow {
  id: string;
  brand_id: string | null;
  anchor_id: string | null;
  platform: string;
  title: string | null;
  status: string;
  embed_url: string | null;
  thumbnail_url: string | null;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
}
interface VideoRow {
  id: string;
  brand_id: string | null;
  title: string;
  platform: string;
  video_url: string;
  embed_type: string;
  description: string | null;
  created_at: string;
  archived_at: string | null;
}
type Brand = { id: string; name: string };
type Anchor = { id: string; name: string };

interface SearchParams {
  brand?: string;
  platform?: string;
  archived?: string;
}

export default async function LiveWallPage({ searchParams }: { searchParams?: SearchParams }) {
  // Whole org operates the wall — view, add/edit sessions, post/edit videos — so
  // any signed-in member passes (requireProfile). canModerate gates only the
  // destructive + AI-spend controls (hard-delete + Analyze) to leadership, matching
  // the server actions' role checks so a member never sees a button that would 403.
  const profile = await requireModule("/live-wall");
  const canModerate = ["ceo", "coo", "department_head"].includes(profile.role);

  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const archived = searchParams?.archived === "1";
  const sessionsQuery = u
    .from("live_sessions")
    .select(
      `id, brand_id, anchor_id, platform, title, status, embed_url, thumbnail_url, started_at, ended_at, archived_at, ${TILE_METRIC_COLUMNS}`
    )
    .order("started_at", { ascending: false, nullsFirst: false });
  const videosQuery = u
    .from("videos")
    .select("id, brand_id, title, platform, video_url, embed_type, description, created_at, archived_at")
    .order("created_at", { ascending: false });
  const [sessionsRes, brandsRes, anchorsRes, videosRes] = await Promise.all([
    archived ? sessionsQuery.not("archived_at", "is", null) : sessionsQuery.is("archived_at", null),
    supabase.from("brands").select("id, name").order("name"),
    u.from("anchors").select("id, name").order("name"),
    archived ? videosQuery.not("archived_at", "is", null) : videosQuery.is("archived_at", null),
  ]);

  const allSessions = (sessionsRes.data ?? []) as SessionRow[];
  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const anchors = (anchorsRes.data ?? []) as Anchor[];
  const videos = (videosRes.data ?? []) as VideoRow[];

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const anchorName = (id: string | null) => anchors.find((a) => a.id === id)?.name ?? "—";

  // ── Filters (BY BRAND, BY PLATFORM) ─────────────────────────────────────────
  const brandFilter = searchParams?.brand || "";
  const platformFilter = searchParams?.platform || "";
  const passBrand = (s: SessionRow) => !brandFilter || s.brand_id === brandFilter;
  const passPlatform = (s: SessionRow) => !platformFilter || s.platform === platformFilter;

  const sessions = allSessions
    .filter((s) => passBrand(s) && passPlatform(s))
    .sort((a, b) => {
      const r = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
      if (r !== 0) return r;
      return (b.started_at ?? "").localeCompare(a.started_at ?? "");
    });

  const liveCount = sessions.filter((s) => s.status === "live").length;
  const nowMs = Date.now();
  const seedFor = (startedAt: string | null) =>
    startedAt ? Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000)) : 0;

  // A small metric cell — honest "—" when the value is null.
  const metricCell = (label: string, value: string, tone = "text-ink") => (
    <div className="rounded-md border border-charcoal-700/60 bg-charcoal-950/40 px-2 py-1.5">
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{label}</p>
      <p className={`mt-0.5 font-mono text-xs ${tone}`}>{value}</p>
    </div>
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live & Video Wall"]} profile={profile}>
      <PageHeader
        title={<>Live &amp; Video Wall <HelpHint id="commerce.liveVideoWall" /></>}
        subtitle="Mission control for every live — all sessions at a glance, with a library of posted videos that play inside the OS. Real numbers only; a metric with no entry reads “—”."
      />

      {/* ── Controls: filters + live-updates toggle ──────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            By brand
            <select name="brand" defaultValue={brandFilter} className={`${fieldCls} mt-1 block w-44`}>
              <option value="">All brands</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            By platform
            <select name="platform" defaultValue={platformFilter} className={`${fieldCls} mt-1 block w-44`}>
              <option value="">All platforms</option>
              {WALL_PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-md bg-teal-500 px-3 py-2 text-xs font-semibold text-charcoal-950 hover:bg-teal-400">
            Apply
          </button>
          {(brandFilter || platformFilter) && (
            <Link href="/live-wall" className="rounded-md bg-charcoal-800 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-700">
              Reset
            </Link>
          )}
        </form>
        <div className="flex items-center gap-3">
          <ArchivedToggle
            basePath="/live-wall"
            archived={archived}
            params={{
              ...(brandFilter ? { brand: brandFilter } : {}),
              ...(platformFilter ? { platform: platformFilter } : {}),
            }}
          />
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            <span aria-hidden className="relative flex h-2.5 w-2.5">
              {liveCount > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" />}
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${liveCount > 0 ? "bg-red-500" : "bg-ink-dim"}`} />
            </span>
            {liveCount} live now
          </span>
          <LiveAutoRefresh />
        </div>
      </div>

      {/* ── Live multiview grid ──────────────────────────────────────────────── */}
      <section className="mb-12">
        {sessions.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-6 text-sm text-ink-muted shadow-elevate">
            {allSessions.length === 0
              ? "No live sessions yet."
              : "No sessions match the current filters."}
            {allSessions.length === 0 && " Add one below to see it on the wall."}
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sessions.map((s) => {
              const m = tileMetricsFromRow(s);
              const title = s.title?.trim() || "Untitled live";
              return (
                <div key={s.id} className="flex flex-col gap-3 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-3 shadow-elevate">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{title}</p>
                      <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                        {brandName(s.brand_id)} · {platformLabel(s.platform)} · {anchorName(s.anchor_id)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={STATUS_TONE[s.status] ?? "muted"}>{statusLabel(s.status)}</Badge>
                      {s.status === "live" && s.started_at && (
                        <ElapsedTime startedAt={s.started_at} seedSeconds={seedFor(s.started_at)} className="font-mono text-[11px] text-ink-muted" />
                      )}
                    </div>
                  </div>

                  {/* Media — inline player or link-out */}
                  <LiveEmbed embedUrl={s.embed_url} platform={s.platform} thumbnailUrl={s.thumbnail_url} title={title} />

                  {/* Live-compartment metrics (viewers / GMV / CTOR) */}
                  <div className="grid grid-cols-3 gap-2">
                    {metricCell("Viewers", intOrDash(m.viewers))}
                    {metricCell("GMV", pesoOrDash(m.gmv), "text-gold-400")}
                    {metricCell("CTOR", pctOrDash(m.ctor, 2), "text-teal-300")}
                  </div>

                  {/* Edit + soft-archive */}
                  <div className="border-t border-charcoal-700/60 pt-2">
                    <RowActions {...rowActionProps("live_sessions", s as unknown as Record<string, unknown>, profile)} />
                  </div>

                  {/* Operate controls — add/edit/status for every member. Analyze
                      (leadership AI spend) and Delete (hard-delete) are canModerate. */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-charcoal-700/60 pt-3">
                      {canModerate && <AnalyzeButton sessionId={s.id} />}
                      {s.status !== "live" && (
                        <form action={setLiveStatus}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="status" value="live" />
                          <input type="hidden" name="started_at" value={s.started_at ?? ""} />
                          <button type="submit" className="rounded-md bg-red-500/90 px-2.5 py-1.5 text-[11px] font-semibold text-charcoal-950 hover:bg-red-400">
                            Go live
                          </button>
                        </form>
                      )}
                      {s.status === "live" && (
                        <form action={setLiveStatus}>
                          <input type="hidden" name="id" value={s.id} />
                          <input type="hidden" name="status" value="ended" />
                          <input type="hidden" name="started_at" value={s.started_at ?? ""} />
                          <input type="hidden" name="ended_at" value={s.ended_at ?? ""} />
                          <button type="submit" className="rounded-md bg-charcoal-800 px-2.5 py-1.5 text-[11px] text-red-300 hover:bg-charcoal-700">
                            End live
                          </button>
                        </form>
                      )}
                      {/* Inline editor (brand / host / platform / title / status / embed / thumbnail) */}
                      <details className="w-full">
                        <summary className="cursor-pointer list-none rounded-md bg-charcoal-800 px-2.5 py-1.5 text-[11px] text-ink-muted hover:bg-charcoal-700 hover:text-ink">
                          Edit tile
                        </summary>
                        <form action={updateLiveSession} className="mt-2 grid grid-cols-2 gap-2">
                          <input type="hidden" name="id" value={s.id} />
                          <input name="title" defaultValue={s.title ?? ""} placeholder="Title" className={`${fieldCls} col-span-2`} />
                          <select name="brand_id" defaultValue={s.brand_id ?? ""} className={fieldCls}>
                            <option value="">Brand…</option>
                            {brands.map((b) => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </select>
                          <select name="anchor_id" defaultValue={s.anchor_id ?? ""} className={fieldCls}>
                            <option value="">Host…</option>
                            {anchors.map((a) => (
                              <option key={a.id} value={a.id}>{a.name}</option>
                            ))}
                          </select>
                          <select name="platform" defaultValue={s.platform} className={fieldCls}>
                            {WALL_PLATFORMS.map((p) => (
                              <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                          </select>
                          <select name="status" defaultValue={s.status} className={fieldCls}>
                            {SESSION_STATUSES.map((st) => (
                              <option key={st} value={st}>{statusLabel(st)}</option>
                            ))}
                          </select>
                          <input name="embed_url" defaultValue={s.embed_url ?? ""} placeholder="Embed / stream URL (YouTube, HLS, MP4)" className={`${fieldCls} col-span-2`} />
                          <input name="thumbnail_url" defaultValue={s.thumbnail_url ?? ""} placeholder="Thumbnail URL (native lives)" className={`${fieldCls} col-span-2`} />
                          <div className="col-span-2 flex items-center gap-2">
                            <button type="submit" className="rounded-md bg-teal-500 px-3 py-1.5 text-[11px] font-semibold text-charcoal-950 hover:bg-teal-400">
                              Save
                            </button>
                            {canModerate && (
                              <button
                                type="submit"
                                formAction={deleteLiveSession}
                                className="rounded-md bg-charcoal-800 px-3 py-1.5 text-[11px] text-red-300 hover:bg-charcoal-700"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </form>
                      </details>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Add a session (every member — live_sessions is org-writable) ──────── */}
      <SectionCard title="Add a live session" className="mb-12">
          <p className="mb-3 text-xs text-ink-muted">
            Set an <span className="text-ink">embed / stream URL</span> (YouTube Live, an HLS/MP4 restream) to play the tile inline. Native TikTok / Shopee / Lazada lives can’t be embedded — leave it blank and add a
            <span className="text-ink"> thumbnail URL</span> instead; the tile shows a “Watch Live” link-out.
          </p>
          <form action={createLiveSession} className="grid gap-3 sm:grid-cols-3">
            <input name="title" placeholder="Session title" className={`${inputCls} sm:col-span-3`} />
            <select name="brand_id" defaultValue="" className={inputCls}>
              <option value="">Brand…</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <select name="anchor_id" defaultValue="" className={inputCls}>
              <option value="">Host…</option>
              {anchors.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select name="platform" defaultValue="tiktok" className={inputCls}>
              {WALL_PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <select name="status" defaultValue="scheduled" className={inputCls}>
              {SESSION_STATUSES.map((st) => (
                <option key={st} value={st}>{statusLabel(st)}</option>
              ))}
            </select>
            <input name="embed_url" placeholder="Embed / stream URL (optional)" className={`${inputCls} sm:col-span-2`} />
            <input name="thumbnail_url" placeholder="Thumbnail URL (optional)" className={`${inputCls} sm:col-span-3`} />
            <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-3">
              Add to wall
            </button>
          </form>
        </SectionCard>

      {/* ── Video library ────────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold text-ink">Video library</h2>
        <p className="mb-4 text-sm text-ink-muted">
          Posted videos that play inside the OS through the official player. Paste a TikTok, YouTube, or direct MP4 link — the whole org can watch.
        </p>

        <SectionCard title="Add a video" className="mb-6">
          <AddVideoForm action={addVideo} brands={brands} />
        </SectionCard>

        {videos.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-6 text-sm text-ink-muted shadow-elevate">
            No videos in the library yet. Paste a link above to add the first one.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {videos.map((v) => (
              <div key={v.id} className="flex flex-col gap-3 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-3 shadow-elevate">
                <VideoPlayer url={v.video_url} embedType={v.embed_type} title={v.title} />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{v.title}</p>
                    <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                      {platformLabel(v.platform)}
                      {v.brand_id ? ` · ${brandName(v.brand_id)}` : ""}
                    </p>
                    {v.description && <p className="mt-1 line-clamp-2 text-[11px] text-ink-dim">{v.description}</p>}
                  </div>
                  {canModerate && (
                    <form action={deleteVideo} className="shrink-0">
                      <input type="hidden" name="id" value={v.id} />
                      <button type="submit" aria-label="Delete video" className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-red-300 hover:bg-charcoal-700">
                        ✕
                      </button>
                    </form>
                  )}
                </div>
                {/* Edit + soft-archive */}
                <div className="border-t border-charcoal-700/60 pt-2">
                  <RowActions {...rowActionProps("videos", v as unknown as Record<string, unknown>, profile)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
