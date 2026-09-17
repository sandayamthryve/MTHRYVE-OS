// lib/capabilities/missions.ts — turn a LIVE/PARTIAL capability into real tasks.
//
// The new part of Vesper Core: a capability is a thing the OS can do; a MISSION
// breaks that capability into concrete, assignable tasks derived from the
// capability's own outputs/steps plus the user's context. The flow is always
// DRAFT → human review/edit → confirm → create:
//
//   1. draftMissionTasks() — PURE. No DB, no side effects. Produces a proposed
//      task list from the capability + context. Both the registry "Create mission
//      tasks" modal and Tony's create_mission_tasks tool draft with this, so the
//      proposal is identical whichever surface asked.
//   2. createMissionTasks() — the CONFIRM step. Inserts the (reviewed) tasks via
//      the existing task-creation flow on the caller's RLS client, stamping
//      tasks.capability_id for traceability. It re-checks the capability is
//      live/partial and never invents an owner: an unresolved assignee → null.
//
// Nothing here auto-creates: createMissionTasks only runs when a caller passes an
// explicit, already-reviewed task list. Planned/vendor capabilities are refused —
// there is nothing to execute yet.

import type { SessionProfile } from "@/lib/auth/session";
import { canRunMission, type Capability } from "@/lib/capabilities/types";

type Shim = { from: (t: string) => any };

export const MISSION_TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type MissionTaskPriority = (typeof MISSION_TASK_PRIORITIES)[number];

// A single drafted task, before it's created. assignee_id is optional and only
// ever set to a REAL user id (resolved by the modal/Tony); assignee_hint carries
// a human-readable suggestion ("E-Commerce lead", a department) for the reviewer
// when we won't guess an id.
export interface MissionTaskDraft {
  title: string;
  description: string;
  priority: MissionTaskPriority;
  due_date: string | null;
  assignee_id: string | null;
  assignee_hint: string | null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
function daysFromNow(n: number): string {
  return ymd(new Date(Date.now() + n * 24 * 60 * 60 * 1000));
}
function clampPriority(v: unknown): MissionTaskPriority {
  return (MISSION_TASK_PRIORITIES as readonly string[]).includes(v as string)
    ? (v as MissionTaskPriority)
    : "medium";
}

// Derive a proposed task list from a capability + optional free-text context.
//
// Shape of a mission:
//   • a kickoff task (scope + owner),
//   • one delivery task per declared output (or a sensible fallback when the
//     capability lists none),
//   • a review/QA task that checks the KPIs.
// Partial capabilities get slightly higher priority — closing a gap is the point.
export function draftMissionTasks(cap: Capability, context: string): MissionTaskDraft[] {
  const ctx = context.trim();
  const ctxLine = ctx ? ` Context: ${ctx}` : "";
  const basePriority: MissionTaskPriority = cap.status === "partial" ? "high" : "medium";
  const hint = `${cap.domain} team`;

  const drafts: MissionTaskDraft[] = [];

  // 1. Kickoff — scope the mission against the capability's requirements.
  drafts.push({
    title: `Kick off: ${cap.name}`,
    description:
      `Scope the "${cap.name}" mission (${cap.domain}). Confirm goal, owner and success criteria.` +
      (cap.required_skills.length ? ` Skills: ${cap.required_skills.join(", ")}.` : "") +
      (cap.required_workflows.length ? ` Workflows: ${cap.required_workflows.join(", ")}.` : "") +
      ctxLine,
    priority: basePriority,
    due_date: daysFromNow(3),
    assignee_id: null,
    assignee_hint: hint,
  });

  // 2. One delivery task per declared output, staggered weekly. Falls back to a
  // single "build out" task when the capability declares no outputs yet (the
  // seed leaves reference arrays for leadership to fill in via the edit UI).
  const hasOutputs = cap.outputs.length > 0;
  const outputs = hasOutputs ? cap.outputs : [cap.name];
  outputs.slice(0, 8).forEach((output, i) => {
    drafts.push({
      title: hasOutputs ? `Deliver: ${output}` : `Build out: ${cap.name}`,
      description: hasOutputs
        ? `Produce "${output}" as part of the ${cap.name} capability (${cap.domain}).` + ctxLine
        : `Do the core work of the ${cap.name} capability (${cap.domain}).` + ctxLine,
      priority: basePriority,
      due_date: daysFromNow(7 * (i + 1)),
      assignee_id: null,
      assignee_hint: hint,
    });
  });

  // 3. Review / QA against the KPIs so the mission has a defined "done".
  drafts.push({
    title: `Review & QA: ${cap.name}`,
    description:
      `Verify the ${cap.name} outputs meet the bar before sign-off.` +
      (cap.kpis.length ? ` KPIs: ${cap.kpis.join(", ")}.` : "") +
      ctxLine,
    priority: "medium",
    due_date: daysFromNow(7 * (outputs.slice(0, 8).length + 1)),
    assignee_id: null,
    assignee_hint: hint,
  });

  return drafts;
}

// Sanitize one task coming back from the confirm step (from the modal, or from
// Tony's reviewed list). Drops anything without a title; never trusts a supplied
// assignee_id blindly — the caller passes `validUserIds` (the org's users, RLS-
// scoped) and an unknown id is nulled rather than used.
export function sanitizeMissionTask(
  raw: unknown,
  validUserIds: Set<string>
): MissionTaskDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return null;
  const description = typeof r.description === "string" ? r.description.trim() : "";
  const dueRaw = typeof r.due_date === "string" ? r.due_date.trim() : "";
  const due_date = YMD_RE.test(dueRaw) ? dueRaw : null;
  const assigneeRaw = typeof r.assignee_id === "string" ? r.assignee_id.trim() : "";
  const assignee_id = assigneeRaw && validUserIds.has(assigneeRaw) ? assigneeRaw : null;
  const assignee_hint =
    typeof r.assignee_hint === "string" && r.assignee_hint.trim() ? r.assignee_hint.trim() : null;
  return {
    title: title.slice(0, 200),
    description: description.slice(0, 2000),
    priority: clampPriority(r.priority),
    due_date,
    assignee_id,
    assignee_hint,
  };
}

export interface CreateMissionResult {
  ok: boolean;
  created?: number;
  capability?: string;
  error?: string;
}

// The CONFIRM step: create the reviewed tasks via the existing task-creation flow,
// each stamped with capability_id for traceability. RLS is the boundary — the
// insert runs on the caller's client, so org scoping and task-creation rights are
// enforced by Postgres, not re-implemented here.
//
// Guards: the capability must exist (RLS-visible) and be live/partial; at least
// one valid task must remain after sanitizing. Assignees are validated against the
// org's users so a fabricated owner can never land on a task.
export async function createMissionTasks(
  db: Shim,
  profile: SessionProfile,
  capability: Capability,
  tasks: unknown[]
): Promise<CreateMissionResult> {
  if (!canRunMission(capability.status)) {
    return {
      ok: false,
      error: `"${capability.name}" is ${capability.status} — there's nothing to execute yet, so it can't become tasks.`,
    };
  }

  // The org's users (RLS-scoped) — the allow-list for assignee ids. A valid but
  // unknown id is nulled rather than trusted.
  const { data: userData } = await db.from("users").select("id");
  const validUserIds = new Set(
    ((userData ?? []) as { id: string }[]).map((u) => u.id)
  );

  const clean = (Array.isArray(tasks) ? tasks : [])
    .map((t) => sanitizeMissionTask(t, validUserIds))
    .filter((t): t is MissionTaskDraft => t !== null);

  if (clean.length === 0) {
    return { ok: false, error: "No valid tasks to create — every row needs a title." };
  }

  const now = new Date().toISOString();
  const rows = clean.map((t) => ({
    org_id: profile.org_id,
    created_by: profile.id,
    title: t.title,
    description: t.description || null,
    assignee_id: t.assignee_id,
    priority: t.priority,
    status: "todo",
    due_date: t.due_date,
    capability_id: capability.id, // traceability: this task came from this capability
    created_at: now,
    updated_at: now,
  }));

  // Insert as a batch on the caller's RLS client. capability_id isn't in the
  // generated types, so the whole insert goes through the cast shim (same as the
  // CSV importers).
  const { error } = await db.from("tasks").insert(rows);
  if (error) return { ok: false, error: error.message };

  return { ok: true, created: rows.length, capability: capability.name };
}
