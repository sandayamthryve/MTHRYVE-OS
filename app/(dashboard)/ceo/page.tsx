import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadMissionControl } from "@/lib/ceo/mission-control";
import { ExecutiveOperatingReview } from "@/components/ceo/ExecutiveOperatingReview";
import { buildSnapshot } from "@/lib/os/snapshot";
import {
  RingGauge,
  Sparkline,
  RevenuePulseChart,
  PlatformDonut,
  DeptHealthBars,
  WorkflowBars,
  FlywheelGauge,
} from "@/components/ceo/charts";
import { ExecutiveFeed } from "@/components/ceo/ExecutiveFeed";
import { QuickEntryLauncher } from "@/components/quick-entry/QuickEntryLauncher";
import { DailyReportCard } from "@/components/daily-reports/DailyReportCard";
import { pesoCompact, EMPTY } from "@/lib/metrics/format";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";

// CEO / COO Mission Control — the "digital HQ", laid out as a cockpit so charts
// and numbers lead and prose is secondary. Top to bottom:
//   ROW 1 · KPI tiles (Business Health ring · Revenue MTD · Cash Flow · AI Cognition)
//   ROW 2 · Revenue Pulse area+line (≈2/3, the centerpiece) + GMV-by-Platform donut (≈1/3)
//   ROW 3 · three chart panels across — Department Health · Growth Flywheel · Workflow Activity
//   BELOW · Executive Briefing (Tony's live feed) — demoted under the charts, no longer the lede.
// EVERY number is read live from the OS's own tables through the shared metrics
// layer (lib/ceo/mission-control) — a metric with no signal shows an honest "—" /
// empty state, never a fabricated figure. Role gating (ceo/coo) and the approval
// flow are unchanged; no schema change.

export const dynamic = "force-dynamic";

// The shared panel surface — the elevated "Obsidian" card used across the page.
function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`relative overflow-hidden rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-5 shadow-elevate ${className}`}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// A KPI tile matching the MetricTile surface, but flexible enough to host a ring,
// a sparkline or a plain figure.
function KpiTile({
  label,
  value,
  valueColor = "text-ink",
  caption,
  accentDot = "teal",
  children,
}: {
  label: string;
  value: string;
  valueColor?: string;
  caption?: React.ReactNode;
  accentDot?: "teal" | "gold" | "green";
  children?: React.ReactNode;
}) {
  const dot =
    accentDot === "gold"
      ? "bg-gold-400 shadow-[0_0_8px_theme(colors.gold.400)]"
      : accentDot === "green"
      ? "bg-green-400 shadow-[0_0_8px_theme(colors.green.400)]"
      : "bg-teal-400 shadow-[0_0_8px_theme(colors.teal.400)]";
  return (
    <div className="relative overflow-hidden rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-4 shadow-elevate">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
      <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-ink-muted">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
        {label}
      </p>
      <p className={`font-display text-3xl font-bold tracking-tight ${valueColor}`}>{value}</p>
      {caption && <div className="mt-2 text-xs text-ink-muted">{caption}</div>}
      {children}
    </div>
  );
}

export default async function CeoMissionControlPage({
  searchParams,
}: {
  searchParams?: DateRangeSearchParams;
}) {
  const profile = await requireRole(["ceo", "coo"]);
  const supabase = createServerSupabaseClient();

  // Shared date-range control. Revenue + GMV-by-Platform re-slice to the picked
  // window; a Compare selection drives the revenue delta. Defaults to MTD, the
  // window this cockpit has always opened on.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const [mc, brandsRes] = await Promise.all([
    loadMissionControl(supabase, profile.org_id, {
      range: { ...dr.range, label: dr.rangeLabel },
      compareRange: dr.compareRange,
      compareLabel: dr.compareLabel,
    }),
    supabase.from("brands").select("id, name").order("name"),
  ]);
  const brands = ((brandsRes.data ?? []) as unknown as { id: string; name: string }[]) ?? [];
  const k = mc.kpis;

  // The Review reads the same OS snapshot the cockpits and client views read, so
  // its client count and its "#1 brand" cannot disagree with them. A failed
  // snapshot costs the Review its book, not the page.
  const snapshot = await (async () => {
    try {
      return await buildSnapshot({
        supabase,
        orgId: profile.org_id,
        role: profile.role,
        range: { ...dr.range, label: dr.rangeLabel },
      });
    } catch {
      return null;
    }
  })();

  const healthColor = k.health == null ? "#63727A" : k.health >= 75 ? "#6BC98A" : k.health >= 50 ? "#4BC0B8" : "#E0BD6E";

  // Revenue MTD delta caption (month-over-month pace, NOT the WoW the old tile
  // implied — the label says exactly what it compares).
  const revDelta = k.revenueDeltaPct;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Mission Control"]} profile={profile}>
      <PageHeader
        title="Mission Control"
        subtitle={
          <>
            Live command center for {profile.full_name.split(" ")[0]}
            {mc.asOf ? <> · as of {mc.asOf} · Manila</> : null}
          </>
        }
      />

      {/* The compiled read of where the company stands, before the instruments. */}
      <ExecutiveOperatingReview
        health={k.health}
        healthBasis={k.healthBasis}
        gmv={k.revenueMtd}
        windowLabel={k.windowLabel}
        snapshot={snapshot}
      />

      {/* Shared date-range control — Revenue & GMV-by-Platform respect the range;
          Compare drives the revenue delta. Persisted in the URL (survives refresh). */}
      <DateRangeControls {...dr.controlProps} brands={brands} />

      {/* Company-wide Daily Report: every role files one, leadership included. */}
      <div className="mb-6">
        <DailyReportCard />
      </div>

      {/* Mobile quick-entry: snap a photo/screenshot of a number → confirm → save,
          with the capture stored as evidence. Launchable from every role home. */}
      <div className="mb-6">
        <QuickEntryLauncher />
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Business Health — ring gauge */}
        <div className="relative overflow-hidden rounded-lg border border-charcoal-700 bg-gradient-to-b from-charcoal-900 to-charcoal-950 p-4 shadow-elevate">
          <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/[.06]" />
          <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-ink-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-400 shadow-[0_0_8px_theme(colors.teal.400)]" aria-hidden />
            Business Health
          </p>
          <div className="flex items-center gap-3">
            <RingGauge value={k.health} color={healthColor} size={84} stroke={9} centerLabel="/100" />
            <div className="min-w-0">
              {k.health == null ? (
                <p className="text-xs text-ink-muted">No efficiency or quality signal yet.</p>
              ) : (
                <p className="text-xs text-ink-muted">
                  Composite of live ops signals.
                  {k.healthBasis ? <span className="mt-1 block font-mono text-[10px] text-ink-dim">{k.healthBasis}</span> : null}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Revenue — windowed figure + delta + sparkline */}
        <KpiTile
          label={`Revenue · ${k.windowLabel}`}
          value={k.revenueMtd == null ? EMPTY : pesoCompact(k.revenueMtd, k.currency)}
          valueColor="text-green-400"
          accentDot="green"
          caption={
            revDelta != null && k.revenueDeltaLabel ? (
              <span
                className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono ${
                  revDelta >= 0 ? "bg-green-500/10 text-green-400" : "bg-gold-500/10 text-gold-400"
                }`}
              >
                {revDelta >= 0 ? "▲" : "▼"} {Math.abs(revDelta)}% {k.revenueDeltaLabel}
              </span>
            ) : k.revenueMtd != null ? (
              `GMV managed · ${k.windowLabel}`
            ) : (
              "No commerce rows yet"
            )
          }
        >
          {k.revenueSpark.length >= 2 && (
            <div className="mt-2">
              <Sparkline points={k.revenueSpark} color="#6BC98A" />
            </div>
          )}
        </KpiTile>

        {/* Cash Flow 30d */}
        <KpiTile
          label="Cash Flow · 30d"
          value={k.cashFlow30d == null ? EMPTY : pesoCompact(k.cashFlow30d, k.currency)}
          valueColor={k.cashFlow30d == null ? "text-ink" : k.cashFlow30d >= 0 ? "text-green-400" : "text-gold-400"}
          accentDot="gold"
          caption={
            k.cashFlow30d == null ? (
              "No cash position set"
            ) : (
              <>
                Projected net · end bal{" "}
                <span className="font-mono text-ink">{pesoCompact(k.cashEndBalance ?? 0, k.currency)}</span>
                {k.cashAsOf ? <span className="block text-[10px] text-ink-dim">from {k.cashAsOf}</span> : null}
              </>
            )
          }
        />

        {/* AI Cognition — active loops */}
        <KpiTile
          label="AI Cognition"
          value={k.activeLoops == null ? EMPTY : String(k.activeLoops)}
          valueColor="text-teal-300"
          accentDot="teal"
          caption={
            k.activeLoops == null
              ? "No proactive loops active yet"
              : `active AI loop${k.activeLoops === 1 ? "" : "s"} · last 30d`
          }
        />
      </div>

      {/* ── ROW 2 — Revenue Pulse (visual centerpiece, ≈2/3) + GMV donut (≈1/3) ── */}
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Panel
          title="Revenue Pulse"
          subtitle="Weekly GMV managed · last 12 weeks"
          className="lg:col-span-2"
          action={
            <Link href="/platforms" className="text-xs text-teal-400 hover:text-teal-300">
              Platforms →
            </Link>
          }
        >
          <RevenuePulseChart pulse={mc.revenuePulse} />
        </Panel>

        <Panel title="GMV by Platform" subtitle={`Sales split · ${mc.platformSplit.windowLabel}`}>
          <PlatformDonut split={mc.platformSplit} />
        </Panel>
      </div>

      {/* ── ROW 3 — three chart panels across: Dept Health · Flywheel · Workflow ── */}
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Panel
          title="Department Health"
          subtitle={
            mc.deptHealth.hasAny
              ? mc.deptHealth.periodLabel
                ? `Composite · wk ${mc.deptHealth.periodLabel}`
                : "Efficiency + quality composite"
              : "Composite from department snapshots"
          }
        >
          {mc.deptHealth.hasAny ? (
            <DeptHealthBars health={mc.deptHealth} />
          ) : (
            <div className="rounded-md border border-dashed border-charcoal-700 bg-charcoal-950/40 px-4 py-8 text-center text-sm text-ink-muted">
              No department snapshots yet — recompute signals on the metrics page to populate this.
            </div>
          )}
        </Panel>

        <Panel title="Growth Flywheel" subtitle="Brands per pod vs target">
          <div className="flex h-full items-center justify-center">
            <FlywheelGauge flywheel={mc.flywheel} />
          </div>
        </Panel>

        <Panel title="Workflow Activity" subtitle="Drafted vs executed · 14d">
          <WorkflowBars workflow={mc.workflow} />
        </Panel>
      </div>

      {/* ── DEMOTED — Executive Briefing / AI feed now sits BELOW the charts ──── */}
      <Panel
        title="Executive Briefing"
        subtitle="Tony's live recommendations, bottlenecks & approvals"
        action={
          mc.feed.pendingTotal > 0 ? (
            <Link href="/approvals" className="text-xs text-teal-400 hover:text-teal-300">
              Queue →
            </Link>
          ) : undefined
        }
      >
        <ExecutiveFeed feed={mc.feed} role={profile.role} />
      </Panel>
    </AppShell>
  );
}
