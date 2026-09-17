import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/components/ui";
import { TASK_STATUS_LABELS, formatDate } from "@/lib/tasks/display";
import {
  challengeSummaryParts,
  type DepartmentActivity,
  type DepartmentBriefing,
} from "@/lib/departments/activity";
import { StalenessBanner, whenLabel } from "@/components/briefings/StalenessBanner";
import type { DepartmentBriefingFigures } from "@/lib/briefings/exec-figures";
import { pctOrDash, pesoOrDash } from "@/lib/metrics/format";

// The auto-derived Department narrative: Ongoing Tasks / Expected Outputs /
// Challenges / Action Plan — rendered ABOVE the Efficiency/Quality/Capacity
// bars on both the Departments and Metrics pages. The first three sub-sections
// read straight from live OS activity; the Action Plan is the latest AI briefing
// written by the grounded engine. Nothing here is typed by hand.

export type ManualNotes = {
  ongoing_tasks?: string | null;
  expected_outputs?: string | null;
  challenges?: string | null;
};

const CONFIDENCE_TONE: Record<string, BadgeTone> = {
  high: "teal",
  medium: "violet",
  low: "amber",
  insufficient: "muted",
};

// Keep each live list tidy — show the first few, note the remainder.
const MAX_ITEMS = 6;

function Label({ children }: { children: ReactNode }) {
  return (
    <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-muted">{children}</p>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-muted">{children}</p>;
}

// A small "Lead's note:" annotation surfaced under a live section when the
// department lead left a manual override on the latest snapshot.
function LeadNote({ text }: { text?: string | null }) {
  if (!text || !text.trim()) return null;
  return (
    <p className="mt-2 border-l-2 border-charcoal-700 pl-2 text-xs text-ink-muted">
      <span className="font-semibold">Lead&rsquo;s note:</span> {text.trim()}
    </p>
  );
}

function overflowNote(total: number): ReactNode {
  if (total <= MAX_ITEMS) return null;
  return <li className="text-xs text-ink-muted">+{total - MAX_ITEMS} more</li>;
}

export function DepartmentNarrative({
  activity,
  briefing,
  manualNotes,
  action,
  liveFigures,
  nowMs,
}: {
  activity: DepartmentActivity;
  briefing: DepartmentBriefing | null;
  manualNotes?: ManualNotes | null;
  action?: ReactNode;
  // PR 8 — the department's snapshot figures resolved LIVE at render time from
  // metrics_snapshots, shown beside the cached action plan (whose efficiency /
  // quality / capacity / GMV-impact are frozen at generation). Null when no
  // snapshot is on file → the strip renders honest "—", never a stale number.
  liveFigures?: DepartmentBriefingFigures | null;
  nowMs?: number;
}) {
  const expected: { key: string; label: string; kind: string; due: string | null }[] = [
    ...activity.expectedTasks.map((t) => ({ key: `t-${t.id}`, label: t.title, kind: "Task", due: t.due_date })),
    ...activity.expectedProjects.map((p) => ({ key: `p-${p.id}`, label: p.name, kind: "Project", due: p.due_date })),
  ].sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));

  const challengeChips = challengeSummaryParts(activity);
  const confidence = (briefing?.data_confidence ?? "").toLowerCase();
  const hasPlan = !!briefing && !!briefing.action_plan && briefing.action_plan.trim().length > 0;

  return (
    <div className="space-y-5">
      {/* ONGOING TASKS */}
      <section>
        <Label>Ongoing Tasks</Label>
        {activity.ongoingTasks.length === 0 ? (
          <Empty>No active tasks</Empty>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {activity.ongoingTasks.slice(0, MAX_ITEMS).map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-2">
                <span className="text-ink">{t.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                  {t.assigneeName ?? "Unassigned"} · {TASK_STATUS_LABELS[t.status]}
                </span>
              </li>
            ))}
            {overflowNote(activity.ongoingTasks.length)}
          </ul>
        )}
        <LeadNote text={manualNotes?.ongoing_tasks} />
      </section>

      {/* EXPECTED OUTPUTS */}
      <section>
        <Label>Expected Outputs</Label>
        {expected.length === 0 ? (
          <Empty>Nothing due in the next 14 days</Empty>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {expected.slice(0, MAX_ITEMS).map((e) => (
              <li key={e.key} className="flex items-start justify-between gap-2">
                <span className="text-ink">
                  <span className="font-mono text-[10px] text-ink-muted">{e.kind}</span> {e.label}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-teal-300">{formatDate(e.due)}</span>
              </li>
            ))}
            {overflowNote(expected.length)}
          </ul>
        )}
        <LeadNote text={manualNotes?.expected_outputs} />
      </section>

      {/* CHALLENGES */}
      <section>
        <Label>Challenges</Label>
        {challengeChips.length === 0 ? (
          <Empty>No blockers detected</Empty>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {challengeChips.map((c) => (
                <Badge key={c} tone="amber">
                  {c}
                </Badge>
              ))}
            </div>
            {(activity.overdueTasks.length > 0 || activity.blockedTasks.length > 0) && (
              <ul className="mt-2 space-y-1.5 text-sm">
                {[...activity.overdueTasks, ...activity.blockedTasks]
                  .slice(0, MAX_ITEMS)
                  .map((t, i) => (
                    <li key={`${t.id}-${i}`} className="flex items-start justify-between gap-2">
                      <span className="text-ink">{t.title}</span>
                      <span className="shrink-0 font-mono text-[10px] text-gold-400">
                        {t.due_date && t.due_date < new Date().toISOString().slice(0, 10)
                          ? `overdue ${formatDate(t.due_date)}`
                          : TASK_STATUS_LABELS[t.status]}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
        <LeadNote text={manualNotes?.challenges} />
      </section>

      {/* ACTION PLAN */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Action Plan</p>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        {!hasPlan ? (
          <Empty>Not generated yet</Empty>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="violet">AI generated</Badge>
              {confidence ? (
                <Badge tone={CONFIDENCE_TONE[confidence] ?? "muted"}>{confidence}</Badge>
              ) : null}
            </div>

            {/* ── Staleness banner — unmissable once the plan is >24h old. Refresh
                reuses the same action control (absent on the read-only Metrics mount). */}
            <StalenessBanner
              createdAt={briefing!.created_at}
              nowMs={nowMs ?? Date.now()}
              noun="action plan"
              refresh={action ?? undefined}
            />

            {/* ── Live figures — resolved at RENDER time from the department's latest
                metrics_snapshots row. These NEVER come from the cached plan; a figure
                with no snapshot renders "—", never a stale number. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: "Efficiency", value: pctOrDash(liveFigures?.efficiency), tone: "text-teal-300" },
                { label: "Quality", value: pctOrDash(liveFigures?.quality), tone: "text-ink" },
                { label: "Capacity", value: pctOrDash(liveFigures?.capacity), tone: "text-ink" },
                { label: "GMV impact", value: pesoOrDash(liveFigures?.gmvImpact), tone: "text-ink-muted" },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-charcoal-700 bg-charcoal-950/50 p-3">
                  <p className="font-mono text-[9px] uppercase tracking-wider text-ink-muted">{c.label}</p>
                  <p className={`mt-0.5 font-mono text-sm ${c.tone}`}>{c.value}</p>
                </div>
              ))}
            </div>
            <p className="font-mono text-[10px] text-ink-muted">
              ↑ Live snapshot figures{liveFigures?.periodEnd ? ` · to ${liveFigures.periodEnd}` : ""} · resolved
              now · the plan below is cached
            </p>

            <p className="whitespace-pre-line text-sm leading-relaxed text-ink">
              {briefing!.action_plan}
            </p>
            <p className="font-mono text-[10px] text-ink-muted">
              generated by {briefing!.model ?? "—"} · {whenLabel(briefing!.created_at)}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
