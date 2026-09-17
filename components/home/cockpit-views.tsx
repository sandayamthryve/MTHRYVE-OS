import Link from "next/link";
import { StatCard } from "@/components/ui/StatCard";
import { SectionCard, Badge } from "@/components/ui";
import { DeptHealthBars } from "@/components/ceo/charts";
import {
  TASK_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  statusPillClasses,
  priorityClasses,
  formatDate,
} from "@/lib/tasks/display";
import { riskTierLabel, riskTierTone, sourceModuleLabel } from "@/lib/actions/types";
import { CATEGORY_LABEL, type CategoryRollup } from "@/lib/live-ops/bottlenecks";
import type {
  MyDayData,
  DeptCockpitData,
  OperationsData,
  DeptMetrics,
  CockpitTask,
  DailyReportStatus,
  MemberReportStanding,
} from "@/lib/home/cockpit";
import type { ActionRequestRow } from "@/lib/actions/types";

// Presentational, READ-ONLY cockpit bodies shared by the live role homes and the
// Leadership View-As surface. They render only reads — every write control (Quick
// Entry, Submit Daily Report, Approve/Reject) is injected by the caller through a
// slot. So the live pages pass interactive controls; View-As passes read-only
// stand-ins (or nothing), guaranteeing a leader viewing another person's home can
// change nothing. All server components — no client hooks here.

const show = (v: number | null | undefined) => (v == null ? "—" : String(Number(v)));

// ── Shared sections ─────────────────────────────────────────────────────────────
export function DeptMetricsStrip({
  metrics,
  label = "Department metrics",
}: {
  metrics: DeptMetrics | null;
  label?: string;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-semibold text-ink">{label}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Efficiency" value={show(metrics?.efficiency)} accent="green" />
        <StatCard label="Quality score" value={show(metrics?.quality_score)} accent="gold" />
        <StatCard label="Capacity" value={show(metrics?.capacity_utilization)} />
      </div>
      {!metrics && (
        <p className="mt-2 text-xs text-ink-muted">
          No department snapshot recorded yet — values read “—”, never a fabricated 0.
        </p>
      )}
    </section>
  );
}

export function TasksPanel({ tasks }: { tasks: CockpitTask[] }) {
  return (
    <SectionCard title="Today's tasks" className="mb-6">
      {tasks.length === 0 ? (
        <p className="text-sm text-ink-muted">No open tasks assigned to you. You're clear.</p>
      ) : (
        <ul className="divide-y divide-charcoal-800">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <Link
                  href={`/tasks/${t.id}`}
                  className="truncate text-sm text-ink hover:text-teal-300"
                >
                  {t.title}
                </Link>
                <p className="mt-0.5 text-[11px] text-ink-dim">
                  <span className={priorityClasses(t.priority)}>{TASK_PRIORITY_LABELS[t.priority]}</span>
                  {" · due "}
                  {formatDate(t.due_date)}
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
      )}
    </SectionCard>
  );
}

// Read-only Daily Report standing — used inside View-As and as the header of the
// live My Day report section. The live page adds the SubmitReportForm below it.
export function ReportStatus({ report }: { report: DailyReportStatus }) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        report.filedToday
          ? "border-teal-500/40 bg-teal-500/10"
          : "border-gold-500/40 bg-gold-500/10"
      }`}
    >
      <p className="text-sm font-semibold text-ink">
        {report.filedToday ? "✓ Daily Report filed today" : "○ Daily Report not filed yet"}
      </p>
      {report.filedToday && report.deliverables && (
        <p className="mt-1 whitespace-pre-line text-xs text-ink-muted">{report.deliverables}</p>
      )}
      {report.filedToday && report.summary && (
        <p className="mt-1.5 text-[11px] text-ink-dim">{report.summary}</p>
      )}
    </div>
  );
}

// Mini-Tony placeholder slot — the member-scoped assistant lands here. Honest
// placeholder, not a fabricated answer.
export function MiniTony() {
  return (
    <SectionCard title="Ask Tony" icon="✦" className="mb-6">
      <p className="text-sm text-ink-muted">
        Your personal AI copilot will surface here — a quick line to Tony scoped to your day and
        your department.
      </p>
      <Link
        href="/assistant"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-b from-green-400 to-green-500 px-3 py-2 text-sm font-medium text-charcoal-950 shadow-glow transition hover:brightness-110"
      >
        <span aria-hidden>✦</span> Open Tony
      </Link>
    </SectionCard>
  );
}

export function WhoFiledPanel({
  standings,
  filedCount,
  memberCount,
}: {
  standings: MemberReportStanding[];
  filedCount: number;
  memberCount: number;
}) {
  return (
    <SectionCard
      title="Daily Reports — today"
      action={
        <span className="font-mono text-xs text-ink-muted">
          {filedCount}/{memberCount} filed
        </span>
      }
      className="mb-6"
    >
      {standings.length === 0 ? (
        <p className="text-sm text-ink-muted">No team members in this department yet.</p>
      ) : (
        <ul className="divide-y divide-charcoal-800">
          {standings.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 py-2">
              <span className="truncate text-sm text-ink">{m.full_name}</span>
              <Badge tone={m.filed ? "teal" : "amber"}>{m.filed ? "Filed" : "Not filed"}</Badge>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function BottlenecksPanel({
  bottlenecks,
  openCount,
}: {
  bottlenecks: CategoryRollup[];
  openCount: number;
}) {
  const active = bottlenecks.filter((b) => b.open > 0);
  return (
    <SectionCard
      title="Live bottlenecks"
      action={
        <Link href="/live-ops/bottlenecks" className="text-xs text-teal-400 hover:text-teal-300">
          All →
        </Link>
      }
      className="mb-6"
    >
      {active.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {openCount === 0 ? "No open bottlenecks across live operations." : "No open bottlenecks by category."}
        </p>
      ) : (
        <ul className="divide-y divide-charcoal-800">
          {active.map((b) => (
            <li key={b.category} className="flex items-center justify-between gap-3 py-2">
              <span className="text-sm text-ink">{CATEGORY_LABEL[b.category]}</span>
              <span className="flex items-center gap-2">
                {b.critical > 0 && <Badge tone="red">{b.critical} critical</Badge>}
                <Badge tone="amber">{b.open} open</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// Compact, read-only approvals list — used by View-As, where NO decision controls
// may render. The live pages render full interactive ActionCards instead (passed
// through the `approvalsSlot`).
export function ApprovalsReadOnly({
  approvals,
  title = "Approvals queue",
}: {
  approvals: ActionRequestRow[];
  title?: string;
}) {
  return (
    <SectionCard title={title} className="mb-6">
      {approvals.length === 0 ? (
        <p className="text-sm text-ink-muted">No pending approvals.</p>
      ) : (
        <ul className="divide-y divide-charcoal-800">
          {approvals.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{a.title}</p>
                <p className="mt-0.5 text-[11px] text-ink-dim">{sourceModuleLabel(a.source_module)}</p>
              </div>
              <Badge tone={riskTierTone(a.risk_tier)}>{riskTierLabel(a.risk_tier)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Assembled cockpit bodies ────────────────────────────────────────────────────
// Each takes its loaded data plus optional write-control slots. When a slot is
// omitted (View-As), the body renders read-only.

export function MyDayView({
  data,
  reportSlot,
  captureSlot,
}: {
  data: MyDayData;
  reportSlot?: React.ReactNode;
  captureSlot?: React.ReactNode;
}) {
  return (
    <>
      {captureSlot}
      <DeptMetricsStrip
        metrics={data.metrics}
        label={data.department ? `${data.department.name} — key metrics` : "Department metrics"}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <TasksPanel tasks={data.tasks} />
        <SectionCard title="Daily Report" className="mb-6">
          <ReportStatus report={data.report} />
          {reportSlot}
        </SectionCard>
      </div>
      <MiniTony />
    </>
  );
}

export function DeptCockpitView({
  data,
  approvalsSlot,
  captureSlot,
}: {
  data: DeptCockpitData;
  approvalsSlot?: React.ReactNode;
  captureSlot?: React.ReactNode;
}) {
  return (
    <>
      {captureSlot}
      {/* Team health */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-ink">Team health</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Team members" value={data.memberCount} />
          <StatCard label="Filed today" value={`${data.filedCount}/${data.memberCount}`} accent="green" />
          <StatCard label="Efficiency" value={show(data.metrics?.efficiency)} accent="green" />
          <StatCard label="Quality" value={show(data.metrics?.quality_score)} accent="gold" />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>{approvalsSlot ?? <ApprovalsReadOnly approvals={data.approvals} />}</div>
        <WhoFiledPanel
          standings={data.standings}
          filedCount={data.filedCount}
          memberCount={data.memberCount}
        />
      </div>

      <DeptMetricsStrip metrics={data.metrics} label="Department metrics" />
    </>
  );
}

export function OperationsView({
  data,
  deptHealth,
  approvalsSlot,
  captureSlot,
}: {
  data: OperationsData;
  // The cross-department health composite from lib/ceo/mission-control.
  deptHealth: React.ComponentProps<typeof DeptHealthBars>["health"];
  approvalsSlot?: React.ReactNode;
  captureSlot?: React.ReactNode;
}) {
  return (
    <>
      {captureSlot}
      <SectionCard title="Cross-department health" className="mb-6">
        {deptHealth.hasAny ? (
          <DeptHealthBars health={deptHealth} />
        ) : (
          <p className="text-sm text-ink-muted">
            No department snapshots yet — recompute signals on the metrics page to populate this.
          </p>
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>{approvalsSlot ?? <ApprovalsReadOnly approvals={data.approvals} title="All approvals" />}</div>
        <BottlenecksPanel bottlenecks={data.bottlenecks} openCount={data.openBottleneckCount} />
      </div>
    </>
  );
}
