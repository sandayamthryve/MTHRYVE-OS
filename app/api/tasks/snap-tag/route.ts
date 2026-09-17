import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { notifyTagged, type TaggedUser } from "@/lib/tasks/snap-tag";
import type { UserRole } from "@/types/database";

// POST /api/tasks/snap-tag — Snap-Tag a task: write task_tags rows for the
// selected teammates, then fire the three best-effort notify channels (bell +
// email + one Telegram group broadcast) for the NEWLY tagged users.
//
// Body: { taskId: string, userIds: string[] }.
//
// Authorization is enforced twice: this handler gates the role, and the tag
// WRITE goes through the caller's RLS-scoped client (the task_tags_write policy
// is ceo/coo/department_head, org-scoped) — so RLS is the real authority, the
// handler check is a friendly fast-fail. De-dupe is intrinsic: only users not
// already tagged on the task are written and notified, so re-tagging is a no-op.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TAG_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(["ceo", "coo", "department_head"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Shim = { from: (t: string) => any };

export async function POST(req: Request) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }
  if (!TAG_ROLES.has(profile.role)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const taskId = typeof (body as any)?.taskId === "string" ? (body as any).taskId : "";
  const rawIds = Array.isArray((body as any)?.userIds) ? (body as any).userIds : [];
  if (!UUID.test(taskId)) {
    return NextResponse.json({ ok: false, error: "invalid taskId" }, { status: 400 });
  }
  const userIds = Array.from(
    new Set(rawIds.filter((x: unknown): x is string => typeof x === "string" && UUID.test(x)))
  );

  const authed = createServerSupabaseClient();

  // Load the task within the caller's RLS scope. A row the caller can't see (or
  // that's cross-org) reads as not-found.
  const { data: taskRow } = await authed
    .from("tasks")
    .select("id, title, due_date, created_by, org_id")
    .eq("id", taskId)
    .maybeSingle();
  const task = taskRow as
    | { id: string; title: string; due_date: string | null; created_by: string | null; org_id: string }
    | null;
  if (!task || task.org_id !== profile.org_id) {
    return NextResponse.json({ ok: false, error: "task not found" }, { status: 404 });
  }

  // Nothing selected → nothing to do (a valid, idempotent no-op).
  if (userIds.length === 0) {
    return NextResponse.json({ ok: true, tagged: 0, recipients: 0, bell: 0, emailed: 0, telegram: false });
  }

  // Service-role reads are the source of truth for org membership + contact
  // fields (email / handle), independent of the caller's read RLS.
  const svc = createServiceRoleClient() as unknown as Shim;

  const { data: usersData } = await svc
    .from("users")
    .select("id, full_name, email, telegram_username")
    .eq("org_id", profile.org_id)
    .in("id", userIds);
  const targets = ((usersData ?? []) as TaggedUser[]).filter((u) => u.id);
  if (targets.length === 0) {
    // None of the ids are real org members → treat as a clean no-op.
    return NextResponse.json({ ok: true, tagged: 0, recipients: 0, bell: 0, emailed: 0, telegram: false });
  }

  // Compute the NEWLY tagged set (skip users already tagged on this task).
  const { data: existingData } = await svc.from("task_tags").select("user_id").eq("task_id", taskId);
  const existing = new Set(((existingData ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  const newly = targets.filter((u) => !existing.has(u.id));

  // Write the tag rows (RLS-scoped client). The unique (task_id, user_id) index
  // is the race backstop — ignoreDuplicates keeps a concurrent double-tag clean.
  if (newly.length > 0) {
    const rows = newly.map((u) => ({
      org_id: task.org_id,
      task_id: taskId,
      user_id: u.id,
      tagged_by: profile.id,
    }));
    const { error } = await (authed as unknown as {
      from: (t: string) => {
        upsert: (v: unknown, opts: { onConflict: string; ignoreDuplicates: boolean }) => Promise<{ error: { message?: string } | null }>;
      };
    })
      .from("task_tags")
      .upsert(rows, { onConflict: "task_id,user_id", ignoreDuplicates: true });
    // The tag write is the ONE thing that must succeed — surface its failure.
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message || "could not write task tags" },
        { status: 500 }
      );
    }
  }

  // Resolve the CREATOR's name for the broadcast ("by <Creator>"). When the
  // tagger is the creator, that's this profile; otherwise look it up.
  let creatorName = profile.full_name;
  if (task.created_by && task.created_by !== profile.id) {
    const { data: c } = await svc.from("users").select("full_name").eq("id", task.created_by).maybeSingle();
    creatorName = (c as { full_name?: string } | null)?.full_name ?? creatorName;
  }

  // Fire the three channels for the newly tagged (best-effort — never gates the
  // tag write above, which has already committed).
  const notified = await notifyTagged({
    orgId: profile.org_id,
    taskId,
    taskTitle: task.title,
    dueDate: task.due_date,
    creatorId: task.created_by,
    creatorName,
    newlyTagged: newly,
  });

  return NextResponse.json({ ok: true, tagged: newly.length, ...notified });
}
