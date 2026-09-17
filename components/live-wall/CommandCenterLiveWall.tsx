import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { intOrDash, pesoOrDash, pctOrDash } from "@/lib/metrics/format";
import { ElapsedTime } from "@/components/live/ElapsedTime";
import { LiveEmbed } from "@/components/live-wall/LiveEmbed";
import { platformLabel } from "@/lib/live-wall/constants";
import {
  tileMetricsFromRow,
  TILE_METRIC_COLUMNS,
  type LiveSessionMetricRow,
} from "@/lib/live-wall/metrics";

// CommandCenterLiveWall — the compact "Live & Video Wall" surface on the
// executive Command Center (route "/"). It's a READ-ONLY multiview of the lives
// on air RIGHT NOW: a small grid of tiles that each play inline (or link out for
// native lives), with the session's honest Live-compartment numbers. It never
// carries the add/edit controls — those live on the full wall (/live-wall),
// reachable via the "Open full wall →" link; the department heads who own Live
// (Live Ops + Creative Studio) already pass the write-gate there.
//
// Honest by construction: it reads the SAME live_sessions rows the full wall
// reads (org-read RLS is the real gate), shows only status = "live", and when
// nothing is on air it renders an explicit empty state — never a fabricated tile
// or a fake number (a metric with no entry reads "—").

export const COMMAND_CENTER_LIVE_LIMIT = 6;

interface LiveTileRow extends LiveSessionMetricRow {
  id: string;
  brand_id: string | null;
  anchor_id: string | null;
  platform: string;
  title: string | null;
  status: string;
  embed_url: string | null;
  thumbnail_url: string | null;
  started_at: string | null;
}
type Named = { id: string; name: string };

export async function CommandCenterLiveWall() {
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  // Only the lives on air right now, newest first, un-archived. Reads through
  // the same RLS-scoped client as every other Command Center query.
  const [sessionsRes, brandsRes, anchorsRes] = await Promise.all([
    u
      .from("live_sessions")
      .select(
        `id, brand_id, anchor_id, platform, title, status, embed_url, thumbnail_url, started_at, ${TILE_METRIC_COLUMNS}`
      )
      .eq("status", "live")
      .is("archived_at", null)
      .order("started_at", { ascending: false, nullsFirst: false }),
    supabase.from("brands").select("id, name").order("name"),
    u.from("anchors").select("id, name").order("name"),
  ]);

  const allLive = (sessionsRes.data ?? []) as LiveTileRow[];
  const brands = (brandsRes.data ?? []) as unknown as Named[];
  const anchors = (anchorsRes.data ?? []) as Named[];

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const anchorName = (id: string | null) => anchors.find((a) => a.id === id)?.name ?? "—";

  const live = allLive.slice(0, COMMAND_CENTER_LIVE_LIMIT);
  const overflow = allLive.length - live.length;

  const nowMs = Date.now();
  const seedFor = (startedAt: string | null) =>
    startedAt ? Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000)) : 0;

  const metricCell = (label: string, value: string, tone = "text-ink") => (
    <div className="rounded-md border border-charcoal-700/60 bg-charcoal-950/40 px-2 py-1.5">
      <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{label}</p>
      <p className={`mt-0.5 font-mono text-xs ${tone}`}>{value}</p>
    </div>
  );

  return (
    <section className="relative overflow-hidden rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-5 shadow-elevate">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold text-ink">Live &amp; Video Wall</h2>
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            <span aria-hidden className="relative flex h-2.5 w-2.5">
              {allLive.length > 0 && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500/70" />
              )}
              <span
                className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                  allLive.length > 0 ? "bg-red-500" : "bg-ink-dim"
                }`}
              />
            </span>
            {allLive.length} live now
          </span>
        </div>
        <Link href="/live-wall" className="text-xs text-teal-400 hover:text-teal-300">
          Open full wall →
        </Link>
      </div>

      {live.length === 0 ? (
        <div className="rounded-md border border-dashed border-charcoal-700 bg-charcoal-950/40 px-4 py-8 text-center text-sm text-ink-muted">
          No live sessions on air right now. When a session goes live it appears here —{" "}
          <Link href="/live-wall" className="text-teal-400 hover:text-teal-300">
            open the full wall
          </Link>{" "}
          to schedule or start one.
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {live.map((s) => {
              const m = tileMetricsFromRow(s);
              const title = s.title?.trim() || "Untitled live";
              return (
                <div
                  key={s.id}
                  className="flex flex-col gap-2.5 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-3 shadow-elevate"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{title}</p>
                      <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                        {brandName(s.brand_id)} · {platformLabel(s.platform)} · {anchorName(s.anchor_id)}
                      </p>
                    </div>
                    {s.started_at && (
                      <ElapsedTime
                        startedAt={s.started_at}
                        seedSeconds={seedFor(s.started_at)}
                        className="shrink-0 font-mono text-[11px] text-red-300"
                      />
                    )}
                  </div>

                  <LiveEmbed
                    embedUrl={s.embed_url}
                    platform={s.platform}
                    thumbnailUrl={s.thumbnail_url}
                    title={title}
                  />

                  <div className="grid grid-cols-3 gap-2">
                    {metricCell("Viewers", intOrDash(m.viewers))}
                    {metricCell("GMV", pesoOrDash(m.gmv), "text-gold-400")}
                    {metricCell("CTOR", pctOrDash(m.ctor, 2), "text-teal-300")}
                  </div>
                </div>
              );
            })}
          </div>
          {overflow > 0 && (
            <p className="mt-3 text-center text-xs text-ink-muted">
              +{overflow} more live ·{" "}
              <Link href="/live-wall" className="text-teal-400 hover:text-teal-300">
                see the full wall →
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
