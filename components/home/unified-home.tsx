import Link from "next/link";
import { SectionCard, StatCard, Badge, type BadgeTone } from "@/components/ui";
import { HEALTH_COLOR, HEALTH_LABEL } from "@/lib/metrics/health";
import type { HealthDot } from "@/lib/metrics/types";
import { pctOrDash, pesoCompact } from "@/lib/metrics/format";
import {
  TASK_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  statusPillClasses,
  priorityClasses,
  formatDate,
} from "@/lib/tasks/display";
import { riskTierLabel, riskTierTone, sourceModuleLabel } from "@/lib/actions/types";
import type {
  DeptHomeData,
  MemberHomeData,
  BrandHealth,
  BrandVerdict,
  HomeTask,
  KpiVsTarget,
  NeedsYou,
  MetricReading,
} from "@/lib/home/unified";
import type { CompartmentScope } from "@/lib/cognition/types";
import type { MemberBrief, BriefSeverity } from "@/lib/home/member-brief";
import type { BrandTrigger } from "@/lib/quality/signal";
import type { TapRecord } from "@/lib/daily-tap/read";
import { tapLink, TIER_LABEL } from "@/lib/daily-tap/types";
import { TapBriefLink } from "@/components/daily-tap/TapBriefLink";

// Presentational, READ-ONLY bodies for the Unified Home (the role/dept landing at
// "/"). Every figure is grounded in real rows by the loaders in lib/home/unified;
// these components only render what they're handed. Server components — no client
// hooks. Honest empty states everywhere: an empty zone says why, never a
// fabricated number.

// ── Brand health ────────────────────────────────────────────────────────────────

const VERDICT_TONE: Record<BrandVerdict, BadgeTone> = {
  off_target: "red",
  on_track: "teal",
  no_data: "muted",
};
const VERDICT_LABEL: Record<BrandVerdict, string> = {
  off_target: "Off target",
  on_track: "On track",
  no_data: "No recent data",
};
const TRIGGER_LABEL: Record<BrandTrigger, string> = {
  return_rate_high: "Return rate high",
  fulfillment_errors_high: "Fulfillment errors high",
  return_rate_rising: "Returns rising",
};

function BrandHealthCard({ brand }: { brand: BrandHealth }) {
  return (
    <li className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{brand.brandName ?? "Unnamed brand"}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-dim">
            {brand.verdict === "no_data" ? (
              "no rows in the trailing 7-day window"
            ) : (
              <>
                GMV {pesoCompact(brand.gmv)} · {brand.orders} orders · return rate{" "}
                {pctOrDash(brand.returnRate != null ? brand.returnRate * 100 : null, 1)}
              </>
            )}
          </p>
        </div>
        <Badge tone={VERDICT_TONE[brand.verdict]}>{VERDICT_LABEL[brand.verdict]}</Badge>
      </div>
      {brand.triggers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {brand.triggers.map((t) => (
            <span
              key={t}
              className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[10px] text-red-300"
            >
              {TRIGGER_LABEL[t]}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function BrandHealthPanel({
  brands,
  title = "Your brands' health",
  emptyHint,
}: {
  brands: BrandHealth[];
  title?: string;
  emptyHint: string;
}) {
  const offTarget = brands.filter((b) => b.verdict === "off_target").length;
  return (
    <SectionCard
      title={title}
      action={
        brands.length > 0 ? (
          <Link href="/brands" className="text-xs text-teal-400 hover:text-teal-300">
            Commerce →
          </Link>
        ) : undefined
      }
      className="mb-6"
    >
      {brands.length === 0 ? (
        <p className="text-sm text-ink-muted">{emptyHint}</p>
      ) : (
        <>
          {offTarget > 0 && (
            <p className="mb-3 text-xs text-ink-muted">
              <span className="font-mono text-red-300">{offTarget}</span> off target ·{" "}
              <span className="font-mono text-teal-300">
                {brands.filter((b) => b.verdict === "on_track").length}
              </span>{" "}
              on track
            </p>
          )}
          <ul className="space-y-2">
            {brands.map((b) => (
              <BrandHealthCard key={b.brandId} brand={b} />
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}

// ── What needs you ────────────────────────────────────────────────────────────────

function NeedsYouPanel({ needsYou }: { needsYou: NeedsYou }) {
  const { approvals, taggedTasks, brandFires } = needsYou;
  const total = approvals.length + taggedTasks.length + brandFires.length;
  return (
    <SectionCard
      title="What needs you"
      action={
        <span className="font-mono text-xs text-ink-muted">
          {total === 0 ? "all clear" : `${total} item${total === 1 ? "" : "s"}`}
        </span>
      }
      className="mb-6"
    >
      {total === 0 ? (
        <p className="text-sm text-ink-muted">
          Nothing is waiting on you — no pending approvals, tagged tasks, or off-target brands.
        </p>
      ) : (
        <div className="space-y-5">
          {/* Pending approvals — head-decidable action_requests */}
          <div>
            <p className="mb-2 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              <span>Pending approvals</span>
              {approvals.length > 0 && (
                <Link href="/approvals" className="text-teal-400 hover:text-teal-300">
                  Queue →
                </Link>
              )}
            </p>
            {approvals.length === 0 ? (
              <p className="text-xs text-ink-muted">None awaiting your decision.</p>
            ) : (
              <ul className="divide-y divide-charcoal-800">
                {approvals.slice(0, 6).map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink">{a.title}</p>
                      <p className="mt-0.5 text-[11px] text-ink-dim">{sourceModuleLabel(a.source_module)}</p>
                    </div>
                    <Badge tone={riskTierTone(a.risk_tier)}>{riskTierLabel(a.risk_tier)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Off-target brand fires — from the reused brand-health pass */}
          {brandFires.length > 0 && (
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                Brands off target
              </p>
              <ul className="space-y-1.5">
                {brandFires.map((b) => (
                  <li key={b.brandId} className="flex items-start justify-between gap-3">
                    <span className="truncate text-sm text-ink">{b.brandName ?? "Unnamed brand"}</span>
                    <span className="shrink-0 text-right font-mono text-[11px] text-red-300">
                      {b.triggers.map((t) => TRIGGER_LABEL[t]).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Tasks tagged to you (Snap-Tag) */}
          {taggedTasks.length > 0 && (
            <div>
              <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                Tasks tagged to you
              </p>
              <TaskList tasks={taggedTasks.slice(0, 8)} />
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── Tony's brief (compartment scope) ──────────────────────────────────────────────

function TonyBriefPanel({ tony }: { tony: CompartmentScope }) {
  return (
    <SectionCard
      title="Tony's brief"
      icon="✦"
      action={
        <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
          Grounded
        </span>
      }
      className="mb-6"
    >
      <p className="mb-3 text-xs text-ink-muted">
        {tony.label} · {tony.grounded}/{tony.readings.length} metrics logged
      </p>
      {tony.readings.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No metrics compartment is mapped to your department yet — log today&rsquo;s numbers in Quick
          Entry so Tony can grade them.
        </p>
      ) : (
        <ul className="space-y-2">
          {tony.readings.map((r) => (
            <li key={r.key} className="flex items-start gap-2.5">
              <Dot dot={r.dot} />
              <div className="min-w-0">
                <p className="text-sm text-ink">{r.label}</p>
                <p className="mt-0.5 text-[11px] text-ink-dim">{r.status}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link
        href="/tony"
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300"
      >
        Open Tony →
      </Link>
    </SectionCard>
  );
}

// ── KPIs vs target ────────────────────────────────────────────────────────────────

function scoreColor(score: number | null): string {
  if (score == null) return "text-ink";
  if (score >= 75) return "text-green-400";
  if (score >= 50) return "text-teal-400";
  return "text-gold-400";
}

function KpiVsTargetPanel({ kpis }: { kpis: KpiVsTarget }) {
  const graded = kpis.readings.filter((r) => r.dot != null);
  return (
    <SectionCard
      title="Your KPIs vs target"
      action={
        <Link href="/metrics" className="text-xs text-teal-400 hover:text-teal-300">
          Metrics →
        </Link>
      }
      className="mb-6"
    >
      <div className="mb-4 flex items-end gap-3">
        <p className={`font-display text-3xl font-bold tracking-tight ${scoreColor(kpis.score)}`}>
          {kpis.score == null ? "—" : `${kpis.score}`}
          {kpis.score != null && <span className="text-base font-medium text-ink-muted">/100</span>}
        </p>
        <p className="pb-1 text-xs text-ink-muted">
          {kpis.score == null
            ? "No graded metric yet — set targets and log numbers to score."
            : `Operating score over ${kpis.graded} graded metric${kpis.graded === 1 ? "" : "s"}`}
        </p>
      </div>
      {graded.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No metric has both a logged value and a target yet — values read &ldquo;—&rdquo;, never a
          fabricated verdict.
        </p>
      ) : (
        <ul className="divide-y divide-charcoal-800">
          {graded.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2.5">
                <Dot dot={r.dot} />
                <span className="truncate text-sm text-ink">{r.label}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-ink-muted">
                {r.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────────────

function Dot({ dot }: { dot: HealthDot }) {
  const cls = dot ? HEALTH_COLOR[dot] : "bg-charcoal-600";
  const label = dot ? HEALTH_LABEL[dot] : "No verdict";
  return <span aria-label={label} title={label} className={`mt-1 h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

function TaskList({ tasks }: { tasks: HomeTask[] }) {
  return (
    <ul className="divide-y divide-charcoal-800">
      {tasks.map((t) => (
        <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <Link href={`/tasks/${t.id}`} className="truncate text-sm text-ink hover:text-teal-300">
              {t.title}
            </Link>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              <span className={priorityClasses(t.priority)}>{TASK_PRIORITY_LABELS[t.priority]}</span>
              {" · due "}
              {formatDate(t.due_date)}
              {t.tagged && t.assigned ? " · assigned + tagged" : t.tagged ? " · tagged" : ""}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusPillClasses(
              t.status
            )}`}
          >
            {TASK_STATUS_LABELS[t.status]}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Member Home widgets ──────────────────────────────────────────────────────────
// Everything below is member-scoped and read-only. NO governance surfaces
// (finance / P&L / audit) mount here — a team member's "/" is their operating
// workspace, not an oversight cockpit.

// Tool Launcher — one-click doors to the exact operating tools a team member
// runs, so they stop door-hunting through the nav. Every href is member-reachable
// (each page guards with requireProfile / own-data writes); the same set the
// sidebar exposes to team_members under Home + Work. No oversight/governance tool.
type LauncherTool = { href: string; label: string; desc: string; icon: string };
const MEMBER_TOOLS: LauncherTool[] = [
  { href: "/tasks", label: "Tasks", desc: "Your work board", icon: "✓" },
  { href: "/content-calendar", label: "Content Calendar", desc: "Plan & schedule posts", icon: "🗓" },
  { href: "/live-wall", label: "Live & Video Wall", desc: "Lives on air now", icon: "◉" },
  { href: "/affiliate", label: "Affiliate", desc: "Creator reach", icon: "★" },
  { href: "/quick-entry", label: "Quick Entry", desc: "Log today's numbers", icon: "⌁" },
  { href: "/reports", label: "Reporting", desc: "Briefs & archive", icon: "▤" },
];

function ToolLauncher() {
  return (
    <SectionCard
      title="Your tools"
      action={<span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Jump in</span>}
      className="mb-6"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {MEMBER_TOOLS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="group flex items-start gap-3 rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3 transition hover:border-teal-500/50 hover:bg-charcoal-900"
          >
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-charcoal-700/60 bg-charcoal-900 text-sm text-teal-300"
            >
              {t.icon}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink group-hover:text-teal-300">
                {t.label}
              </span>
              <span className="block truncate text-[11px] text-ink-dim">{t.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}

// Quick-Entry shortcut — the one action a member does daily. A prominent CTA so
// logging today's numbers is never more than one tap away from home.
function QuickEntryCard() {
  return (
    <SectionCard title="Quick Entry" icon="⌁" className="mb-6">
      <p className="mb-4 text-sm text-ink-muted">
        Log today&rsquo;s numbers in seconds — it feeds your KPIs, your brand&rsquo;s health, and Tony&rsquo;s read.
      </p>
      <Link
        href="/quick-entry"
        className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-teal-300 to-teal-500 px-3 py-2 text-sm font-medium text-charcoal-950 transition hover:brightness-110"
      >
        Log today&rsquo;s entry
        <span aria-hidden>→</span>
      </Link>
    </SectionCard>
  );
}

// Daily AI Tap — the member's morning brief, grounded in today's real numbers.
// Reuses the tap record + its one call-to-action (opening the brief marks the tap
// acted via TapBriefLink). Honest empty when no tap was recorded for today.
function DailyTapCard({ tap }: { tap: TapRecord | null }) {
  const link = tap ? tapLink(tap.tier) : null;
  return (
    <SectionCard
      title="Daily AI Tap"
      icon="✦"
      action={
        <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
          {tap?.ai_used ? "AI synthesis" : "Grounded"}
        </span>
      }
      className="mb-6"
    >
      {!tap ? (
        <p className="text-sm text-ink-muted">
          No tap yet for today — your morning brief lands here once today&rsquo;s numbers are in.{" "}
          <Link href="/daily-tap" className="text-teal-400 hover:text-teal-300">
            Past taps →
          </Link>
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="muted">{TIER_LABEL[tap.tier]}</Badge>
            {tap.acted_at ? <Badge tone="teal">Read</Badge> : null}
          </div>
          {tap.summary ? (
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{tap.summary}</p>
          ) : (
            <p className="text-sm text-ink-muted">Your tap was recorded — open it for the full read.</p>
          )}
          {link && (
            <div className="mt-4">
              <TapBriefLink href={link.href} label={link.label} />
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

// Scoped AI Brief — the member's "root cause + top action today", distilled from
// THEIR brands + KPI readings only (lib/home/member-brief). It is READ-ONLY: it
// recommends and links to member-reachable tools, never an approve/run button; a
// fix that needs a privileged change is flagged as routing to the existing
// approval gates. Honest-null aware — stale/missing reads "—" and, when nothing
// is fresh, it says "not enough fresh data" instead of guessing.
const SEVERITY_TONE: Record<BriefSeverity, BadgeTone> = {
  critical: "red",
  watch: "amber",
  steady: "teal",
  no_data: "muted",
};
const SEVERITY_LABEL: Record<BriefSeverity, string> = {
  critical: "Needs action",
  watch: "Watch",
  steady: "On track",
  no_data: "Not enough fresh data",
};

function AiBriefPanel({ brief }: { brief: MemberBrief }) {
  return (
    <SectionCard
      title="Your AI Brief"
      icon="✦"
      action={
        <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
          Grounded
        </span>
      }
      className="mb-6"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[brief.severity]}>{SEVERITY_LABEL[brief.severity]}</Badge>
        <span className="font-mono text-[10px] text-ink-dim">{brief.freshnessNote}</span>
      </div>

      {!brief.hasFreshData ? (
        <p className="text-sm text-ink-muted">
          Not enough fresh data to brief you yet — your brand and KPI feeds read &ldquo;—&rdquo; until
          today&rsquo;s numbers are in. Nothing here is guessed.
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
              Root cause
            </p>
            {brief.rootCause ? (
              <>
                <p className="text-sm text-ink">{brief.rootCause}</p>
                {brief.evidence && <p className="mt-1 text-[11px] text-ink-dim">{brief.evidence}</p>}
              </>
            ) : (
              <p className="text-sm text-ink-muted">
                Every fresh metric is on target — no off-target driver to flag today.
              </p>
            )}
          </div>
        </div>
      )}

      {brief.topAction && (
        <div className="mt-4 border-t border-charcoal-800 pt-4">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
            Top action today
          </p>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">{brief.topAction.rationale}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={brief.topAction.href}
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal-500/50 bg-teal-500/10 px-3 py-1.5 text-xs font-medium text-teal-200 transition hover:bg-teal-500/20"
            >
              {brief.topAction.label}
              <span aria-hidden>→</span>
            </Link>
            {brief.topAction.routesToApproval && (
              <span className="font-mono text-[10px] text-ink-dim">
                Bigger fixes route to the approval queue — nothing auto-runs.
              </span>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ── Assembled bodies ────────────────────────────────────────────────────────────────

export function DeptHome({ data }: { data: DeptHomeData }) {
  return (
    <>
      <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Assigned brands" value={data.brands.length} />
        <StatCard
          label="Off target"
          value={data.brands.filter((b) => b.verdict === "off_target").length}
          accent="gold"
        />
        <StatCard label="Needs you" value={data.needsYou.approvals.length + data.needsYou.taggedTasks.length} />
        <StatCard
          label="Operating score"
          value={data.kpis.score == null ? "—" : data.kpis.score}
          accent="green"
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <BrandHealthPanel
          brands={data.brands}
          emptyHint="No brands are assigned to your pods yet — assign brands to a pod you lead in Growth → Pods, and their health lands here."
        />
        <NeedsYouPanel needsYou={data.needsYou} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <TonyBriefPanel tony={data.tony} />
        <KpiVsTargetPanel kpis={data.kpis} />
      </div>
    </>
  );
}

export function MemberHome({ data }: { data: MemberHomeData }) {
  const open = data.tasks.length;
  return (
    <>
      {/* At-a-glance — the member's own counters (no governance figures). */}
      <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Open tasks" value={open} />
        <StatCard label="Your brands" value={data.brands.length} />
        <StatCard
          label="Operating score"
          value={data.kpis.score == null ? "—" : data.kpis.score}
          accent="green"
        />
      </section>

      {/* Tool Launcher — one-tap doors to the tools they operate, so members stop
          hunting through the nav. */}
      <ToolLauncher />

      {/* Daily AI Tap + Quick Entry — the two daily rituals, side by side. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <DailyTapCard tap={data.tap} />
        <QuickEntryCard />
      </div>

      {/* Member-scoped AI Brief — root cause + top action today, grounded in this
          member's own brands + KPIs. Read-only; routes any action to the gates. */}
      <AiBriefPanel brief={data.brief} />

      {/* My Tasks — assigned ∪ tagged. */}
      <SectionCard
        title="Your tasks"
        action={
          <Link href="/tasks" className="text-xs text-teal-400 hover:text-teal-300">
            All tasks →
          </Link>
        }
        className="mb-6"
      >
        {data.tasks.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No open tasks assigned or tagged to you. You&rsquo;re clear.
          </p>
        ) : (
          <TaskList tasks={data.tasks} />
        )}
      </SectionCard>

      {/* My Brand health R/A/G · My Targets vs actual. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <BrandHealthPanel
          brands={data.brands}
          title="Your brand's health"
          emptyHint="No brand is assigned to you yet — brands are assigned to Growth Pods, and their health lands here once you lead one."
        />
        <KpiVsTargetPanel kpis={data.kpis} />
      </div>
    </>
  );
}
