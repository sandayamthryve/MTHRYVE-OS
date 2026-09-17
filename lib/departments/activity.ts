import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TaskStatus, TaskPriority, ProjectStatus } from "@/types/database";

// Live department activity — the single source of truth for the auto-derived
// Department narrative (Ongoing Tasks / Expected Outputs / Challenges). This is
// the SAME task-gathering + bottleneck logic the Departments drill-down page has
// always used (tasks have no department_id, so we collect them by the dept's
// project ids OR its member ids, then dedupe), lifted here so both the
// Departments page and the Metrics page render one consistent, real-time view.
// Everything is org-scoped by Postgres RLS through the passed client.

type Supabase = ReturnType<typeof createServerSupabaseClient>;

export type ActivityMember = {
  id: string;
  full_name: string;
  role: string;
  position: string | null;
};

export type ActivityProject = {
  id: string;
  name: string;
  status: ProjectStatus;
  due_date: string | null;
  owner_id: string | null;
};

export type ActivityTask = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  project_id: string | null;
  assignee_id: string | null;
  assigneeName: string | null;
};

export type DepartmentActivity = {
  members: ActivityMember[];
  projects: ActivityProject[];
  tasks: ActivityTask[];
  nameById: Map<string, string>;
  // Narrative buckets, all derived from the live rows above.
  ongoingTasks: ActivityTask[];
  expectedTasks: ActivityTask[];
  expectedProjects: ActivityProject[];
  overdueTasks: ActivityTask[];
  blockedTasks: ActivityTask[];
  unassignedTasks: ActivityTask[];
  overdueProjects: ActivityProject[];
  hasBottlenecks: boolean;
};

// The upcoming-due window for "Expected outputs" — deliverables due soon.
const EXPECTED_WINDOW_DAYS = 14;

function ymd(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
}

export async function getDepartmentActivity(
  supabase: Supabase,
  departmentId: string
): Promise<DepartmentActivity> {
  const [membersRes, projectsRes] = await Promise.all([
    supabase
      .from("users")
      .select("id, full_name, role, position")
      .eq("department_id", departmentId)
      .order("full_name"),
    supabase
      .from("projects")
      .select("id, name, status, due_date, owner_id")
      .eq("department_id", departmentId)
      .order("created_at", { ascending: false }),
  ]);

  const members = (membersRes.data ?? []) as unknown as ActivityMember[];
  const projects = (projectsRes.data ?? []) as unknown as ActivityProject[];

  // Tasks have no department_id — collect them by the dept's project ids OR by
  // its member ids (assignee), then dedupe by task id.
  const projectIds = projects.map((p) => p.id);
  const memberIds = members.map((m) => m.id);

  const taskSelect = "id, title, status, priority, due_date, project_id, assignee_id";
  const taskQueries: Promise<{ data: unknown }>[] = [];
  if (projectIds.length > 0) {
    taskQueries.push(
      supabase.from("tasks").select(taskSelect).in("project_id", projectIds) as unknown as Promise<{
        data: unknown;
      }>
    );
  }
  if (memberIds.length > 0) {
    taskQueries.push(
      supabase.from("tasks").select(taskSelect).in("assignee_id", memberIds) as unknown as Promise<{
        data: unknown;
      }>
    );
  }
  const taskResults = taskQueries.length > 0 ? await Promise.all(taskQueries) : [];
  const taskById = new Map<string, Omit<ActivityTask, "assigneeName">>();
  for (const res of taskResults) {
    for (const t of (res.data ?? []) as unknown as Omit<ActivityTask, "assigneeName">[]) {
      taskById.set(t.id, t);
    }
  }
  const rawTasks = Array.from(taskById.values());

  // Resolve every referenced person's name in one pass (assignees + owners that
  // aren't already department members).
  const nameById = new Map(members.map((m) => [m.id, m.full_name]));
  const missing = new Set<string>();
  for (const t of rawTasks) if (t.assignee_id && !nameById.has(t.assignee_id)) missing.add(t.assignee_id);
  for (const p of projects) if (p.owner_id && !nameById.has(p.owner_id)) missing.add(p.owner_id);
  if (missing.size > 0) {
    const extraRes = await supabase
      .from("users")
      .select("id, full_name")
      .in("id", Array.from(missing));
    for (const u of (extraRes.data ?? []) as unknown as { id: string; full_name: string }[]) {
      nameById.set(u.id, u.full_name);
    }
  }

  const tasks: ActivityTask[] = rawTasks.map((t) => ({
    ...t,
    assigneeName: t.assignee_id ? nameById.get(t.assignee_id) ?? null : null,
  }));

  // Buckets — computed against today's date (YYYY-MM-DD).
  const today = ymd();
  const horizon = ymd(EXPECTED_WINDOW_DAYS * 86_400_000);
  const isOpen = (s: TaskStatus) => s !== "done" && s !== "cancelled";

  const ongoingTasks = tasks.filter((t) => isOpen(t.status));
  const expectedTasks = tasks.filter(
    (t) => t.due_date && t.due_date >= today && t.due_date <= horizon && isOpen(t.status)
  );
  const expectedProjects = projects.filter(
    (p) => p.due_date && p.due_date >= today && p.due_date <= horizon && p.status === "active"
  );
  const overdueTasks = tasks.filter(
    (t) => t.due_date && t.due_date < today && ["todo", "in_progress", "blocked"].includes(t.status)
  );
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const unassignedTasks = tasks.filter((t) => !t.assignee_id && isOpen(t.status));
  const overdueProjects = projects.filter(
    (p) => p.due_date && p.due_date < today && p.status === "active"
  );
  const hasBottlenecks =
    overdueTasks.length + blockedTasks.length + unassignedTasks.length + overdueProjects.length > 0;

  return {
    members,
    projects,
    tasks,
    nameById,
    ongoingTasks,
    expectedTasks,
    expectedProjects,
    overdueTasks,
    blockedTasks,
    unassignedTasks,
    overdueProjects,
    hasBottlenecks,
  };
}

// Short, code-truthful summary of the detected challenges — never invented.
// Rendered as chips in the narrative and stored on the briefing row.
export function challengeSummaryParts(a: DepartmentActivity): string[] {
  const parts: string[] = [];
  if (a.overdueTasks.length) parts.push(`${a.overdueTasks.length} overdue task${a.overdueTasks.length === 1 ? "" : "s"}`);
  if (a.blockedTasks.length) parts.push(`${a.blockedTasks.length} blocked`);
  if (a.unassignedTasks.length) parts.push(`${a.unassignedTasks.length} unassigned`);
  if (a.overdueProjects.length) parts.push(`${a.overdueProjects.length} overdue project${a.overdueProjects.length === 1 ? "" : "s"}`);
  return parts;
}

export type DepartmentBriefing = {
  id: string;
  action_plan: string | null;
  challenges_summary: string | null;
  data_confidence: string | null;
  model: string | null;
  created_at: string;
};

// Latest AI action plan for a department (most recent by created_at).
export async function getLatestDepartmentBriefing(
  supabase: Supabase,
  departmentId: string
): Promise<DepartmentBriefing | null> {
  const res = await supabase
    .from("department_briefings")
    .select("id, action_plan, challenges_summary, data_confidence, model, created_at")
    .eq("department_id", departmentId)
    .order("created_at", { ascending: false })
    .limit(1);
  return ((res.data ?? [])[0] ?? null) as unknown as DepartmentBriefing | null;
}
