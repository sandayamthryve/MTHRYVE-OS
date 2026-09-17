import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass } from "@/components/ui";
import { DepartmentNarrative } from "@/components/departments/DepartmentNarrative";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  priorityClasses,
  formatDate,
} from "@/lib/tasks/display";
import { getDepartmentActivity, getLatestDepartmentBriefing } from "@/lib/departments/activity";
import { generateDepartmentActionPlan } from "@/lib/briefings/generate";
import { deptFiguresFromSnapshot } from "@/lib/briefings/exec-figures";
import type { ProjectStatus } from "@/types/database";

// Department drill-down — pick a department and see its people, work,
// bottlenecks, and latest results in one view. The Department narrative
// (Ongoing Tasks / Expected Outputs / Challenges / Action Plan) auto-derives
// from live OS activity via getDepartmentActivity and the latest AI briefing;
// it renders ABOVE the Efficiency/Quality/Capacity bars. Read-only browsing;
// RLS keeps every query org-scoped.

type Dept = { id: string; name: string; lead_user_id: string | null };
type Snapshot = {
  id: string;
  efficiency: number | null;
  quality_score: number | null;
  capacity_utilization: number | null;
  gmv_impact: number | null;
  period_start: string | null;
  period_end: string | null;
  ongoing_tasks: string | null;
  expected_outputs: string | null;
  challenges: string | null;
};

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

function Bar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-ink-muted">{label}</span>
        <span className="font-mono text-ink">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
        <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Active",
  planned: "Next",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};

export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: { dept?: string };
}) {
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const canManage =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const supabase = createServerSupabaseClient();
  const deptId = (searchParams.dept ?? "").trim();

  const deptListRes = await supabase.from("departments").select("id, name").order("name");
  const departments = (deptListRes.data ?? []) as unknown as { id: string; name: string }[];

  return (
    <AppShell breadcrumb={["Mthryve OS", "Departments"]} profile={profile}>
      <PageHeader
        title="Departments"
        subtitle="Pick a department to see its projects, tasks, bottlenecks, and latest results."
      />

      <form action="/departments" method="get" className="mb-8 flex gap-2">
        <select
          name="dept"
          defaultValue={deptId}
          className="w-full max-w-sm rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
        >
          <option value="">Choose a department…</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
          View
        </button>
      </form>

      {!deptId ? (
        <p className="text-sm text-ink-muted">Pick a department above to drill in.</p>
      ) : (
        <Drilldown deptId={deptId} canManage={canManage} />
      )}
    </AppShell>
  );
}

async function Drilldown({ deptId, canManage }: { deptId: string; canManage: boolean }) {
  const supabase = createServerSupabaseClient();

  // The department row (org-scoped by RLS) — bail early if it isn't visible.
  const deptRes = await supabase
    .from("departments")
    .select("id, name, lead_user_id")
    .eq("id", deptId)
    .single();
  const dept = (deptRes.data as unknown as Dept | null) ?? null;

  if (!dept) {
    return <p className="text-sm text-ink-muted">Department not found.</p>;
  }

  // Live activity (shared helper) + latest snapshot + latest AI action plan.
  const [activity, snapRes, briefing] = await Promise.all([
    getDepartmentActivity(supabase, deptId),
    supabase
      .from("metrics_snapshots")
      .select(
        "id, efficiency, quality_score, capacity_utilization, gmv_impact, period_start, period_end, ongoing_tasks, expected_outputs, challenges"
      )
      .eq("department_id", deptId)
      .order("period_end", { ascending: false })
      .limit(1),
    getLatestDepartmentBriefing(supabase, deptId),
  ]);

  const snapshot = ((snapRes.data ?? [])[0] as unknown as Snapshot | undefined) ?? null;
  const { members, projects, tasks, nameById } = activity;

  // Lead name — resolve if the lead isn't already among the referenced people.
  let leadName = dept.lead_user_id ? nameById.get(dept.lead_user_id) ?? null : null;
  if (dept.lead_user_id && !leadName) {
    const leadRes = await supabase
      .from("users")
      .select("full_name")
      .eq("id", dept.lead_user_id)
      .single();
    leadName = (leadRes.data as unknown as { full_name: string } | null)?.full_name ?? null;
  }

  const tasksByStatus = (status: (typeof TASK_STATUSES)[number]) =>
    tasks.filter((t) => t.status === status);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-ink">{dept.name}</h2>
        <p className="text-sm text-ink-muted">Lead: {leadName ?? "No lead assigned"}</p>
      </div>

      {/* Department narrative — auto-derived from live activity, above the bars */}
      <section>
        <h3 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
          Department narrative
        </h3>
        <SectionCard title="What's happening now">
          <DepartmentNarrative
            activity={activity}
            briefing={briefing}
            liveFigures={deptFiguresFromSnapshot(snapshot)}
            nowMs={Date.now()}
            manualNotes={
              snapshot
                ? {
                    ongoing_tasks: snapshot.ongoing_tasks,
                    expected_outputs: snapshot.expected_outputs,
                    challenges: snapshot.challenges,
                  }
                : null
            }
            action={
              canManage ? (
                <form action={generateDepartmentActionPlan}>
                  <input type="hidden" name="department_id" value={dept.id} />
                  <button
                    type="submit"
                    className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400"
                  >
                    {briefing ? "Refresh Action Plan" : "Generate Action Plan"}
                  </button>
                </form>
              ) : undefined
            }
          />
        </SectionCard>
      </section>

      {/* Results */}
      <section>
        <h3 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Results</h3>
        {snapshot ? (
          <SectionCard
            title="Latest snapshot"
            action={
              <p className="font-mono text-[10px] text-ink-muted">
                {snapshot.period_start} → {snapshot.period_end}
              </p>
            }
          >
            <div className="space-y-2.5">
              <Bar label="Efficiency" value={Number(snapshot.efficiency ?? 0)} />
              <Bar label="Quality" value={Number(snapshot.quality_score ?? 0)} />
              <Bar label="Capacity" value={Number(snapshot.capacity_utilization ?? 0)} />
            </div>
            {snapshot.gmv_impact ? (
              <p className="mt-3 font-mono text-[11px] text-teal-300">GMV impact {peso(Number(snapshot.gmv_impact))}</p>
            ) : null}
          </SectionCard>
        ) : (
          <p className="text-sm text-ink-muted">No metrics recorded yet for this department.</p>
        )}
      </section>

      {/* Task board */}
      <section>
        <h3 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
          Task board · {tasks.length}
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {TASK_STATUSES.map((status) => {
            const group = tasksByStatus(status);
            return (
              <div key={status} className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-ink">{TASK_STATUS_LABELS[status]}</span>
                  <span className="font-mono text-xs text-ink-muted">{group.length}</span>
                </div>
                <div className="space-y-2">
                  {group.length === 0 ? (
                    <p className="text-xs text-ink-muted">—</p>
                  ) : (
                    group.map((t) => (
                      <div key={t.id} className="rounded-md border border-charcoal-700/60 bg-charcoal-950 p-2">
                        <p className="text-sm text-ink">{t.title}</p>
                        <div className="mt-1 flex items-center justify-between">
                          <span className={`text-[11px] font-medium ${priorityClasses(t.priority)}`}>
                            {TASK_PRIORITY_LABELS[t.priority]}
                          </span>
                          <span className="font-mono text-[10px] text-ink-muted">{formatDate(t.due_date)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Bottlenecks */}
      <section>
        <h3 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Bottlenecks</h3>
        {!activity.hasBottlenecks ? (
          <p className="text-sm text-ink-muted">No bottlenecks detected on the available data.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <BottleneckPanel title="Overdue tasks" count={activity.overdueTasks.length}>
              {activity.overdueTasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2">
                  <span className="text-ink">{t.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-gold-400">{formatDate(t.due_date)}</span>
                </li>
              ))}
            </BottleneckPanel>
            <BottleneckPanel title="Blocked tasks" count={activity.blockedTasks.length}>
              {activity.blockedTasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2">
                  <span className="text-ink">{t.title}</span>
                  <span className={`shrink-0 text-[11px] font-medium ${priorityClasses(t.priority)}`}>
                    {TASK_PRIORITY_LABELS[t.priority]}
                  </span>
                </li>
              ))}
            </BottleneckPanel>
            <BottleneckPanel title="Unassigned tasks" count={activity.unassignedTasks.length}>
              {activity.unassignedTasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2">
                  <span className="text-ink">{t.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                    {TASK_STATUS_LABELS[t.status]}
                  </span>
                </li>
              ))}
            </BottleneckPanel>
            <BottleneckPanel title="Overdue projects" count={activity.overdueProjects.length}>
              {activity.overdueProjects.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span className="text-ink">{p.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-gold-400">{formatDate(p.due_date)}</span>
                </li>
              ))}
            </BottleneckPanel>
          </div>
        )}
      </section>

      {/* Projects */}
      <section>
        <h3 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
          Projects · {projects.length}
        </h3>
        {projects.length === 0 ? (
          <p className="text-sm text-ink-muted">No projects for this department.</p>
        ) : (
          <TableShell columns={["Project", "Status", "Due", "Owner"]}>
                {projects.map((p) => (
                  <tr key={p.id} className={rowClass}>
                    <td className="px-4 py-2.5 text-ink">{p.name}</td>
                    <td className="px-4 py-2.5 text-ink-muted">{PROJECT_STATUS_LABELS[p.status]}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">{formatDate(p.due_date)}</td>
                    <td className="px-4 py-2.5 text-ink-muted">
                      {p.owner_id ? nameById.get(p.owner_id) ?? "—" : "—"}
                    </td>
                  </tr>
                ))}
          </TableShell>
        )}
      </section>

      {/* Team */}
      <section>
        <h3 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
          Team · {members.length}
        </h3>
        {members.length === 0 ? (
          <p className="text-sm text-ink-muted">No team members in this department.</p>
        ) : (
          <TableShell columns={["Name", "Role", "Position"]}>
                {members.map((m) => (
                  <tr key={m.id} className={rowClass}>
                    <td className="px-4 py-2.5 text-ink">{m.full_name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-muted">{m.role}</td>
                    <td className="px-4 py-2.5 text-ink-muted">{m.position ?? "—"}</td>
                  </tr>
                ))}
          </TableShell>
        )}
      </section>
    </div>
  );
}

function BottleneckPanel({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">{title}</span>
        <span className="font-mono text-xs text-ink-muted">{count}</span>
      </div>
      {count === 0 ? (
        <p className="text-xs text-ink-muted">None</p>
      ) : (
        <ul className="space-y-1.5 text-sm">{children}</ul>
      )}
    </div>
  );
}
