"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LiveHeader } from "@/components/metrics/LiveHeader";
import type { TonyNode, TonyView, NodeStatus } from "@/lib/tony/types";

// TonyConstellation — the live agent-constellation hero for the Tony Command View.
//
// A radial ring of domain nodes orbits a glowing "Tony" core. Every node shows
// ONE real number from the OS (or an honest "no data yet"); the ONLY things that
// move are the visual orbit/float and the status pulse — the numbers are static
// server-rendered text. Motion is pure CSS and is globally neutralised under
// prefers-reduced-motion (see app/globals.css). Desktop renders the constellation;
// mobile degrades to a clean vertical grid of the same nodes. Clicking a node
// opens a right-side panel with its key numbers, the latest grounded briefing,
// and a primary action into the detailed view.

const STATUS_STYLE: Record<
  NodeStatus,
  { dot: string; ping: string; ring: string; text: string; label: string; glow: string }
> = {
  green: {
    dot: "bg-green-400",
    ping: "bg-green-400",
    ring: "border-green-500/40 hover:border-green-400/70",
    text: "text-green-400",
    label: "Healthy",
    glow: "shadow-[0_0_24px_-6px_rgba(76,175,109,0.55)]",
  },
  amber: {
    dot: "bg-gold-400",
    ping: "bg-gold-400",
    ring: "border-gold-500/40 hover:border-gold-400/70",
    text: "text-gold-400",
    label: "Attention",
    glow: "shadow-[0_0_24px_-6px_rgba(212,169,75,0.5)]",
  },
  red: {
    dot: "bg-red-500",
    ping: "bg-red-500",
    ring: "border-red-500/50 hover:border-red-400/80",
    text: "text-red-400",
    label: "Alert",
    glow: "shadow-[0_0_26px_-6px_rgba(239,68,68,0.55)]",
  },
  muted: {
    dot: "bg-ink-dim",
    ping: "bg-ink-dim",
    ring: "border-charcoal-700 hover:border-charcoal-700",
    text: "text-ink-dim",
    label: "No data",
    glow: "",
  },
};

// Pulse cadence reflects recency (visual only): fresher signal → livelier ping.
function pingDuration(recencyMs: number | null): string {
  if (recencyMs == null) return "0s"; // no signal → no ping
  const hours = recencyMs / 3_600_000;
  if (hours < 6) return "1.8s";
  if (hours < 24) return "2.6s";
  if (hours < 72) return "3.6s";
  return "5s";
}

interface Point {
  x: number;
  y: number;
}

function StatusDot({ status, recencyMs }: { status: NodeStatus; recencyMs: number | null }) {
  const s = STATUS_STYLE[status];
  const dur = pingDuration(recencyMs);
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {status !== "muted" && dur !== "0s" && (
        <span
          aria-hidden
          className={`tony-ping absolute inline-flex h-full w-full rounded-full ${s.ping}`}
          style={{ animationDuration: dur }}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${s.dot}`} />
    </span>
  );
}

// The compact node face, shared by the constellation and the mobile grid.
function NodeCard({
  node,
  onOpen,
  compact,
}: {
  node: TonyNode;
  onOpen: (n: TonyNode) => void;
  compact?: boolean;
}) {
  const s = STATUS_STYLE[node.status];
  return (
    <button
      type="button"
      onClick={() => onOpen(node)}
      aria-label={`${node.label} — ${node.metric ?? "no data yet"}. Open details.`}
      className={`group flex ${
        compact ? "w-full" : "w-[8.5rem]"
      } flex-col gap-1 rounded-xl border bg-charcoal-900/85 p-3 text-left backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:bg-charcoal-850 ${
        s.ring
      } ${node.status !== "muted" ? s.glow : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] uppercase tracking-wider text-ink-muted">
          {node.label}
        </span>
        <StatusDot status={node.status} recencyMs={node.recencyMs} />
      </div>
      {node.metric ? (
        <span className="font-display text-lg font-bold leading-tight tracking-tight text-ink">
          {node.metric}
        </span>
      ) : (
        <span className="font-display text-sm font-semibold leading-tight text-ink-dim">
          No data yet
        </span>
      )}
      <span className="truncate text-[11px] text-ink-muted">
        {node.metric ? node.metricNote ?? node.domain : node.domain}
      </span>
    </button>
  );
}

// Right-side detail panel for a selected node.
function NodePanel({ node, onClose }: { node: TonyNode; onClose: () => void }) {
  const s = STATUS_STYLE[node.status];
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label={`${node.label} details`}>
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="flex-1 bg-black/50 backdrop-blur-[1px]"
      />
      <div className="tony-appear ml-auto flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-charcoal-700 bg-charcoal-950 shadow-elevate sm:w-[26rem]">
        <div className="flex items-start justify-between gap-3 border-b border-charcoal-700/60 p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`inline-flex h-2 w-2 rounded-full ${s.dot}`} />
              <h2 className="text-base font-semibold text-ink">{node.label}</h2>
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">{node.domain}</span>
            </div>
            <p className={`mt-1 font-mono text-[10px] uppercase tracking-wider ${s.text}`}>{s.label}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-charcoal-800 hover:text-ink"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          {/* Headline metric */}
          <div className="mb-5 rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-4">
            {node.metric ? (
              <>
                <p className="font-display text-2xl font-bold tracking-tight text-ink">{node.metric}</p>
                {node.metricNote && <p className="mt-1 text-xs text-ink-muted">{node.metricNote}</p>}
              </>
            ) : (
              <>
                <p className="font-display text-lg font-semibold text-ink-dim">No data yet</p>
                <p className="mt-1 text-xs text-ink-muted">{node.hint ?? "Nothing recorded for this domain yet."}</p>
              </>
            )}
          </div>

          {/* Key numbers */}
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Key numbers</p>
          <dl className="mb-5 grid grid-cols-2 gap-3">
            {node.stats.map((st) => (
              <div key={st.label} className="rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-3">
                <dt className="text-[11px] text-ink-muted">{st.label}</dt>
                <dd className="mt-0.5 truncate font-mono text-sm text-ink">{st.value}</dd>
              </div>
            ))}
          </dl>

          {node.hint && node.metric && (
            <p className="mb-5 rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-3 text-xs text-ink-muted">
              {node.hint}
            </p>
          )}

          {/* Latest grounded briefing */}
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Latest AI briefing</p>
          {node.brief ? (
            <div className="mb-5 rounded-lg border border-violet-500/25 bg-violet-500/[0.06] p-3">
              <p className="text-sm leading-relaxed text-ink">{node.brief}</p>
              {node.briefMeta && <p className="mt-2 font-mono text-[10px] text-ink-dim">{node.briefMeta}</p>}
            </div>
          ) : (
            <p className="mb-5 rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-3 text-xs text-ink-muted">
              No briefing generated for this domain yet.
            </p>
          )}

          {/* Primary action */}
          {node.href ? (
            <Link
              href={node.href}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-semibold text-charcoal-950 transition hover:bg-teal-400"
            >
              {node.actionLabel ?? "Open"} <span aria-hidden>→</span>
            </Link>
          ) : (
            <p className="rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-3 text-center text-xs text-ink-muted">
              No detailed view connected yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// The Tony core + "Ask Tony" input — reuses the real grounded assistant
// (Ask Mthryve AI) by routing the query into /assistant.
function TonyCore() {
  const router = useRouter();
  const [ask, setAsk] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Hand off to the existing grounded assistant. It's recommend-only and reads
    // live OS data — we don't answer here, we open the real thing.
    router.push("/assistant");
  }
  return (
    <div className="flex w-[15rem] max-w-[80vw] flex-col items-center gap-4">
      {/* Glowing core */}
      <div className="relative flex h-28 w-28 items-center justify-center">
        <span aria-hidden className="tony-core-pulse absolute inset-0 rounded-full bg-teal-400/25 blur-xl" />
        <span
          aria-hidden
          className="tony-core-pulse absolute inset-2 rounded-full bg-gradient-to-br from-teal-300/40 to-teal-600/20"
          style={{ animationDelay: "0.6s" }}
        />
        <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-teal-300 to-teal-500 font-display text-xl font-bold text-charcoal-950 shadow-glow">
          Tony
        </span>
      </div>

      {/* Ask Tony → the grounded assistant */}
      <form onSubmit={submit} className="w-full">
        <div className="flex items-center gap-1.5 rounded-full border border-charcoal-700 bg-charcoal-900/90 px-3 py-1.5 backdrop-blur-sm transition-colors focus-within:border-teal-500">
          <span aria-hidden className="text-green-400">✦</span>
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            placeholder="Ask Tony…"
            aria-label="Ask Tony"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
          />
          <button
            type="submit"
            aria-label="Open assistant"
            className="rounded-full bg-teal-500 px-2.5 py-1 text-xs font-semibold text-charcoal-950 transition hover:bg-teal-400"
          >
            →
          </button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-ink-dim">
          Grounded in your live OS data · opens Ask Mthryve AI
        </p>
      </form>
    </div>
  );
}

export function TonyConstellation({ view }: { view: TonyView }) {
  const { nodes } = view;
  const [selected, setSelected] = useState<TonyNode | null>(null);

  // Polar positions for the desktop ring: evenly spaced, first node at the top.
  const points = useMemo<Point[]>(() => {
    const n = nodes.length;
    const R = 41; // radius in viewBox-percent units
    return nodes.map((_, i) => {
      const theta = (-90 + (360 / n) * i) * (Math.PI / 180);
      return { x: 50 + R * Math.cos(theta), y: 50 + R * Math.sin(theta) };
    });
  }, [nodes]);

  return (
    <>
      {/* ── Desktop: radial constellation ── */}
      <div className="tony-appear relative mx-auto hidden aspect-square w-full max-w-[46rem] md:block">
        {/* Decorative orbit rings (visual only) */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="tony-orbit-spin absolute left-1/2 top-1/2 h-[82%] w-[82%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-charcoal-700/50" />
          <div className="absolute left-1/2 top-1/2 h-[56%] w-[56%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-charcoal-700/40" />
          <div
            className="tony-orbit-spin absolute left-1/2 top-1/2 h-[30%] w-[30%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-charcoal-700/30"
            style={{ animationDirection: "reverse", animationDuration: "60s" }}
          />
        </div>

        {/* Spokes from the core to each node */}
        <svg aria-hidden viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none">
          {points.map((p, i) => (
            <line
              key={nodes[i].id}
              x1="50"
              y1="50"
              x2={p.x}
              y2={p.y}
              stroke="currentColor"
              className={
                nodes[i].status === "muted" ? "text-charcoal-700/40" : "text-teal-500/25"
              }
              strokeWidth="0.2"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {/* Center core */}
        <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
          <TonyCore />
        </div>

        {/* Orbiting nodes */}
        {nodes.map((node, i) => (
          <div
            key={node.id}
            className="absolute z-20"
            style={{ left: `${points[i].x}%`, top: `${points[i].y}%`, transform: "translate(-50%, -50%)" }}
          >
            <div className="tony-float" style={{ animationDelay: `${(i % 6) * 0.7}s` }}>
              <NodeCard node={node} onOpen={setSelected} />
            </div>
          </div>
        ))}
      </div>

      {/* ── Mobile: core + vertical grid of the same nodes ── */}
      <div className="tony-appear md:hidden">
        <div className="mb-6 flex justify-center">
          <TonyCore />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {nodes.map((node) => (
            <NodeCard key={node.id} node={node} onOpen={setSelected} compact />
          ))}
        </div>
      </div>

      {selected && <NodePanel node={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
