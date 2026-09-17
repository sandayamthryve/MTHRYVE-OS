import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeAudit } from "@/lib/audit/log";
import {
  canCoverTask,
  notifyOwnerCovered,
  type CoverAction,
} from "@/lib/tasks/coverage";
import { TASK_STATUSES, TASK_STATUS_LABELS } from "@/lib/tasks/display";
import type { TaskStatus } from "@/types/database";

// POST /api/tasks/cover — Head Cover Mode. A department head (or leadership)
// acts on a MEMBER's task on their behalf: reassign it, change its status, or
// mark it complete. Every accepted action writes ONE audit_log row (who covered
// whom, on what task) and fires a best-effort notice to the ORIGINAL OWNER.
//
// Body: { taskId: string, action: 'reassign' | 'status' | 'complete',
//         assigneeId?: string (reassign), status?: TaskStatus (status) }.
//
// Authorization is enforced HERE, on the server, through canCoverTask — the same
// predicate the task-detail UI uses to decide whether to show the coverage
// panel. The gate:
//   • leadership (ceo/coo) may cover any task in the org,
//   • a department_head may cover ONLY a task owned by a member of THEIR OWN
//     department — never another department's,
//   • a member (or anyone acting on their own task) is rejected 403.
// The owner's department + contact fields are read through the service role (the
// source of truth), so the gate can't be fooled by a caller's read RLS. The task
// WRITE itself goes through the caller's RLS-scoped client — no RLS is weakened.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS: ReadonlySet<CoverAction> = new Set<CoverAction>(["reassign", "status", "complete"]);

type Shim = { from: (t: string) => any };

type OwnerRow = {
  id: string;
  full_name: string;
  email: string | null;
  department_id: string | null;
  org_id: string;
};

export async function POST(req: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const taskId = typeof (body as any)?.taskId === "string" ? (body as any).taskId : "";
  const action = (body as any)?.action as CoverAction;
  if (!UUID.test(taskId)) {
    return NextResponse.json({ ok: false, error: "invalid taskId" }, { status: 400 });
  }
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ ok: false, error: "invalid action" }, { status: 400 });
  }

  const authed = createServerSupabaseClient();

  // Load the task within the caller's RLS scope. A row the caller can't see (or
  // that's cross-org) reads as not-found.
  const { data: taskRow } = await authed
    .from("tasks")
    .select("id, title, status, assignee_id, org_id")
    .eq("id", taskId)
    .maybeSingle();
  const task = taskRow as
    | { id: string; title: string; status: TaskStatus; assignee_id: string | null; org_id: string }
    | null;
  if (!task || task.org_id !== profile.org_id) {
    return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
  }

  // Coverage acts on a MEMBER's task — the task's owner is its assignee. A task
  // with no assignee has no one to cover on behalf of.
  if (!task.assignee_id) {
    return NextResponse.json({ ok: false, error: "task has no owner to cover" }, { status: 400 });
  }

  // The owner's department + contact fields are the source of truth for the
  // gate and the notice — read them through the service role, independent of the
  // caller's read RLS.
  const svc = createServiceRoleClient() as unknown as Shim;
  const { data: ownerData } = await svc
    .from("users")
    .select("id, full_name, email, department_id, org_id")
    .eq("id", task.assignee_id)
    .maybeSingle();
  const owner = ownerData as OwnerRow | null;
  if (!owner || owner.org_id !== profile.org_id) {
    return NextResponse.json({ ok: false, error: "task owner not found" }, { status: 404 });
  }

  // THE gate. Same predicate the UI reads. A member, a self-edit, or a head
  // reaching outside their department all fail here → 403.
  const allowed = canCoverTask(
    { id: profile.id, role: profile.role, department_id: profile.department_id },
    { id: owner.id, department_id: owner.department_id }
  );
  if (!allowed) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Resolve the concrete write + a human summary for the audit trail and the
  // owner's notice. before → after is captured for the audit detail.
  let update: Record<string, unknown> = {};
  let summary = "";
  const detail: Record<string, unknown> = {
    cover_action: action,
    owner_id: owner.id,
    owner_department_id: owner.department_id,
    coverer_role: profile.role,
  };

  if (action === "reassign") {
    const assigneeId =
      typeof (body as any)?.assigneeId === "string" ? (body as any).assigneeId : "";
    if (!UUID.test(assigneeId)) {
      return NextResponse.json({ ok: false, error: "invalid assigneeId" }, { status: 400 });
    }
    // The new assignee must be a real member of the same org.
    const { data: newAssigneeData } = await svc
      .from("users")
      .select("id, full_name, org_id")
      .eq("id", assigneeId)
      .maybeSingle();
    const newAssignee = newAssigneeData as
      | { id: string; full_name: string; org_id: string }
      | null;
    if (!newAssignee || newAssignee.org_id !== profile.org_id) {
      return NextResponse.json({ ok: false, error: "unknown assignee" }, { status: 400 });
    }
    update = { assignee_id: assigneeId };
    const toName = assigneeId === profile.id ? "themselves" : newAssignee.full_name;
    summary = `reassigned it to ${toName}`;
    detail.before_assignee_id = owner.id;
    detail.after_assignee_id = assigneeId;
  } else if (action === "complete") {
    update = { status: "done" };
    summary = "marked it complete";
    detail.before_status = task.status;
    detail.after_status = "done";
  } else {
    // action === 'status'
    const status = (body as any)?.status as TaskStatus;
    if (!(TASK_STATUSES as string[]).includes(status)) {
      return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
    }
    update = { status };
    summary = `set the status to "${TASK_STATUS_LABELS[status]}"`;
    detail.before_status = task.status;
    detail.after_status = status;
  }

  // The write goes through the caller's RLS-scoped client (no RLS weakening).
  // `as never` sidesteps the @supabase/ssr .update() → never inference quirk.
  const { error: updErr } = await authed
    .from("tasks")
    .update(update as never)
    .eq("id", taskId);
  if (updErr) {
    return NextResponse.json(
      { ok: false, error: updErr.message || "could not update task" },
      { status: 500 }
    );
  }

  // ONE audit row per coverage action — who covered whom, on what task. Written
  // through the service role (unforgeable), best-effort (never blocks the action).
  await writeAudit({
    action: "task_covered",
    entityType: "task",
    entityId: taskId,
    detail,
    actorUserId: profile.id,
    actorRole: profile.role,
    orgId: profile.org_id,
  });

  // Tell the original owner their task was covered (bell + best-effort email).
  const notified = await notifyOwnerCovered({
    orgId: profile.org_id,
    taskId,
    taskTitle: task.title,
    ownerId: owner.id,
    ownerEmail: owner.email,
    covererName: profile.full_name,
    action,
    summary,
  });

  return NextResponse.json({ ok: true, action, summary, ...notified });
}
