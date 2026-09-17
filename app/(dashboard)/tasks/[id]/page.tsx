import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { TaskControls } from "@/components/tasks/TaskControls";
import { TaskCoverageControls } from "@/components/tasks/TaskCoverageControls";
import { TaskTagControl } from "@/components/tasks/TaskTagControl";
import { CommentForm } from "@/components/tasks/CommentForm";
import { AddSubtaskForm } from "@/components/tasks/AddSubtaskForm";
import { SectionCard, Card } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { canCoverTask } from "@/lib/tasks/coverage";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  TASK_STATUS_LABELS,
  TASK_PRIORITY_LABELS,
  statusPillClasses,
  priorityClasses,
  formatDate,
} from "@/lib/tasks/display";
import type { TaskStatus, TaskPriority } from "@/types/database";

type TaskDetail = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  project_id: string | null;
  assignee_id: string | null;
  brand_id: string | null;
  created_by: string | null;
  created_at: string;
};
type SubtaskRow = { id: string; title: string; status: TaskStatus };
type CommentRow = { id: string; body: string; author_id: string | null; created_at: string };
type NamedRow = { id: string; name: string };
type UserRow = { id: string; full_name: string; department_id: string | null };

export default async function TaskDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const { data: taskRow } = await supabase
    .from("tasks")
    .select(
      "id, title, description, status, priority, due_date, project_id, assignee_id, brand_id, created_by, created_at"
    )
    .eq("id", params.id)
    .single();

  const task = taskRow as TaskDetail | null;
  if (!task) notFound();

  const [subtasksRes, commentsRes, usersRes, projectsRes, brandsRes, tagsRes] = await Promise.all([
    supabase.from("tasks").select("id, title, status").eq("parent_task_id", task.id).order("created_at"),
    supabase
      .from("task_comments")
      .select("id, body, author_id, created_at")
      .eq("task_id", task.id)
      .order("created_at"),
    supabase.from("users").select("id, full_name, department_id").order("full_name"),
    supabase.from("projects").select("id, name"),
    supabase.from("brands").select("id, name"),
    supabase.from("task_tags").select("user_id").eq("task_id", task.id),
  ]);

  const subtasks = (subtasksRes.data ?? []) as unknown as SubtaskRow[];
  const comments = (commentsRes.data ?? []) as unknown as CommentRow[];
  const users = (usersRes.data ?? []) as unknown as UserRow[];
  const projects = (projectsRes.data ?? []) as unknown as NamedRow[];
  const brands = (brandsRes.data ?? []) as unknown as NamedRow[];
  const taggedUserIds = ((tagsRes.data ?? []) as unknown as { user_id: string }[]).map(
    (r) => r.user_id
  );

  // Snap-Tag on edit is leadership / department-head only (mirrors the
  // task_tags_write RLS policy). Everyone can SEE who's tagged.
  const canTag =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";

  // Head Cover Mode. The task's owner is its assignee. The viewer may COVER —
  // act on the owner's behalf — when canCoverTask says so (leadership over
  // anyone; a department head only over a member of their own department; never
  // your own task). This is the SAME predicate /api/tasks/cover enforces on the
  // write, so the panel never shows where the action would be refused.
  const owner = task.assignee_id ? users.find((u) => u.id === task.assignee_id) ?? null : null;
  const canCover =
    !!owner &&
    canCoverTask(
      { id: profile.id, role: profile.role, department_id: profile.department_id },
      { id: owner.id, department_id: owner.department_id }
    );
  // Reassigning SOMEONE ELSE's assigned task is coverage (audited panel above).
  // Plain controls only let you reassign an UNASSIGNED task, your OWN task, or —
  // for leadership — anything. A member can never reassign a teammate's task.
  const isLeadership = profile.role === "ceo" || profile.role === "coo";
  const viewerIsOwner = !!task.assignee_id && task.assignee_id === profile.id;
  const canReassign = !task.assignee_id || viewerIsOwner || isLeadership;

  const userName = new Map(users.map((u) => [u.id, u.full_name]));
  const projectName = task.project_id
    ? projects.find((p) => p.id === task.project_id)?.name ?? null
    : null;
  const brandLabel = task.brand_id ? brands.find((b) => b.id === task.brand_id)?.name ?? null : null;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Tasks", task.title]} profile={profile}>
      <div className="mb-4">
        <Link href="/tasks" className="text-sm text-teal-400 hover:text-teal-300">
          ← All tasks
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main column */}
        <div className="lg:col-span-2">
          <div className="mb-2 flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClasses(task.status)}`}
            >
              {TASK_STATUS_LABELS[task.status]}
            </span>
            <span className={`text-xs font-medium ${priorityClasses(task.priority)}`}>
              {TASK_PRIORITY_LABELS[task.priority]} priority
            </span>
          </div>
          <h1 className="mb-2 text-xl font-bold text-ink">{task.title}</h1>
          {task.description && <p className="mb-4 text-sm text-ink-muted">{task.description}</p>}

          {/* Subtasks */}
          <SectionCard title="Subtasks" className="mt-6">
            {subtasks.length === 0 ? (
              <p className="text-sm text-ink-muted">No subtasks yet.</p>
            ) : (
              <ul className="divide-y divide-charcoal-700/70">
                {subtasks.map((s) => (
                  <li key={s.id} className="flex items-center justify-between py-2">
                    <Link href={`/tasks/${s.id}`} className="text-sm text-ink hover:text-teal-400">
                      {s.title}
                    </Link>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${statusPillClasses(s.status)}`}
                    >
                      {TASK_STATUS_LABELS[s.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <AddSubtaskForm
              orgId={profile.org_id}
              userId={profile.id}
              parentTaskId={task.id}
              projectId={task.project_id}
            />
          </SectionCard>

          {/* Comments */}
          <section className="mt-6">
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Comments {comments.length > 0 && `(${comments.length})`}
            </h2>
            <ul className="space-y-3">
              {comments.map((c) => (
                <li key={c.id} className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-medium text-ink">
                      {c.author_id ? userName.get(c.author_id) ?? "Someone" : "Someone"}
                    </span>
                    <span className="font-mono text-[10px] text-ink-muted">
                      {new Date(c.created_at).toISOString().slice(0, 10)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-ink-muted">{c.body}</p>
                </li>
              ))}
            </ul>
            <CommentForm taskId={task.id} userId={profile.id} />
          </section>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
          <SectionCard title={canCover ? "Head cover mode" : "Details"}>
            {canCover && owner ? (
              <TaskCoverageControls
                taskId={task.id}
                status={task.status}
                ownerName={userName.get(owner.id) ?? "this teammate"}
                selfId={profile.id}
                users={users
                  .filter((u) => u.id !== owner.id)
                  .map((u) => ({ id: u.id, name: u.full_name }))}
              />
            ) : (
              <TaskControls
                taskId={task.id}
                status={task.status}
                priority={task.priority}
                assigneeId={task.assignee_id}
                users={users.map((u) => ({ id: u.id, name: u.full_name }))}
                canReassign={canReassign}
              />
            )}
          </SectionCard>

          <SectionCard title="Tagged teammates">
            {taggedUserIds.length === 0 ? (
              <p className="text-sm text-ink-muted">No one tagged yet.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {taggedUserIds.map((uid) => (
                  <li
                    key={uid}
                    className="rounded-full bg-charcoal-800 px-2 py-0.5 text-xs text-teal-300"
                  >
                    {userName.get(uid) ?? "Teammate"}
                  </li>
                ))}
              </ul>
            )}
            {canTag && (
              <div className="mt-3 border-t border-charcoal-700/70 pt-3">
                <TaskTagControl
                  taskId={task.id}
                  users={users.map((u) => ({ id: u.id, name: u.full_name }))}
                  taggedUserIds={taggedUserIds}
                  creatorId={task.created_by}
                />
              </div>
            )}
          </SectionCard>

          <Card className="text-sm">
            <dl className="space-y-2">
              <div className="flex justify-between">
                <dt className="text-ink-muted">Project</dt>
                <dd className="text-ink">{projectName ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Brand</dt>
                <dd className="text-ink">{brandLabel ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Due date</dt>
                <dd className="font-mono text-xs text-ink">{formatDate(task.due_date)}</dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>
    </AppShell>
  );
}
