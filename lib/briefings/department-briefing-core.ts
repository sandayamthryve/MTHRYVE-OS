// lib/briefings/department-briefing-core.ts
// PR 8 — the ONE department action-plan generation core, shared by the interactive
// "Refresh Action Plan" server action (lib/briefings/generate.ts →
// generateDepartmentActionPlan) and the GitHub Actions daily regeneration route
// (app/api/automation/department-briefings). Extracting it means a human refresh
// and the scheduled machine run gather the SAME real rows, build the SAME grounded
// prompt, and write the SAME department_briefings shape. Mirrors
// lib/briefings/org-briefing-core.ts and account-briefing-core.ts exactly.
//
// getDepartmentActivity is department-scoped (by department_id / project_id /
// member id, all globally unique), so it is correct under both the RLS client and
// the RLS-bypassing service-role client. The one org-wide read here — the latest
// metrics_snapshots row — is scoped with an explicit org_id so the machine run
// never reads across orgs.
//
// Grounds ONLY in real rows; refuses to invent when data is too thin (records an
// honest "insufficient" note, no AI call). Never throws for the caller.
import { peso as fmtPeso } from "@/lib/metrics/format";
import { getDepartmentActivity, challengeSummaryParts } from "@/lib/departments/activity";
import { TASK_STATUS_LABELS } from "@/lib/tasks/display";
import { anthropicMessages } from "@/lib/briefings/anthropic";

type AnyClient = { from: (t: string) => any };

const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));

export const ACTION_PLAN_SYSTEM_PROMPT =
  "You are an operations strategist for a Philippine TikTok Shop & Shopee agency. Using ONLY the data provided about a department — its metrics snapshot, ongoing tasks, upcoming deliverables, and detected challenges — write a concise, concrete action plan of 3 to 5 prioritized actions that directly address the challenges and the metric gaps. Order them most-urgent first. Each action is one or two sentences, specific and doable. Ground everything ONLY in the data provided; never invent numbers, names, deadlines, or facts. Respond as a plain numbered list (1., 2., 3., ...) with no preamble and no closing remarks.";

type DeptSnapshot = {
  efficiency: number | null;
  quality_score: number | null;
  capacity_utilization: number | null;
  gmv_impact: number | null;
  period_start: string | null;
  period_end: string | null;
};

export interface RunDepartmentActionPlanResult {
  status: "generated" | "insufficient" | "error";
  data_confidence: string;
}

// Full generate + persist for ONE department. No auth, no revalidate — the caller
// owns those. generatedBy is null for a machine run (the GitHub Actions schedule has no user).
export async function runDepartmentActionPlan(
  client: AnyClient,
  opts: { orgId: string; departmentId: string; model: string; generatedBy: string | null }
): Promise<RunDepartmentActionPlanResult> {
  const { orgId, departmentId, model, generatedBy } = opts;

  const [activity, snapRes, deptRes] = await Promise.all([
    getDepartmentActivity(client as any, departmentId),
    client
      .from("metrics_snapshots")
      .select("efficiency, quality_score, capacity_utilization, gmv_impact, period_start, period_end")
      .eq("org_id", orgId)
      .eq("department_id", departmentId)
      .order("period_end", { ascending: false })
      .limit(1),
    client.from("departments").select("name").eq("id", departmentId).single(),
  ]);

  const snapshot = ((snapRes.data ?? [])[0] ?? null) as unknown as DeptSnapshot | null;
  const deptName = (deptRes.data as unknown as { name: string } | null)?.name ?? "This department";
  const challengesSummary = challengeSummaryParts(activity).join(", ") || "No blockers detected";

  // Data-sufficiency guard: essentially no activity and no metrics → do NOT call
  // the model; store an honest, low-confidence note instead.
  if (!snapshot && activity.tasks.length < 2 && activity.projects.length === 0) {
    await client.from("department_briefings").insert({
      org_id: orgId,
      department_id: departmentId,
      action_plan:
        "Not enough activity yet to recommend a plan. Add tasks or projects for this department, or record a metrics snapshot, then generate again.",
      challenges_summary: challengesSummary,
      data_confidence: "insufficient",
      model,
      generated_by: generatedBy,
    });
    return { status: "insufficient", data_confidence: "insufficient" };
  }

  // Compact, factual context — the model sees only these real figures.
  const lines: string[] = [`Department: ${deptName}.`];
  if (snapshot) {
    lines.push(
      `Latest metrics snapshot (${snapshot.period_start ?? "?"} → ${snapshot.period_end ?? "?"}): ` +
        `efficiency ${num(snapshot.efficiency)}%, quality ${num(snapshot.quality_score)}%, ` +
        `capacity ${num(snapshot.capacity_utilization)}%` +
        (snapshot.gmv_impact ? `, GMV impact ${fmtPeso(num(snapshot.gmv_impact))}` : "") +
        "."
    );
  } else {
    lines.push("No metrics snapshot recorded yet.");
  }
  lines.push(
    `Ongoing tasks (${activity.ongoingTasks.length}): ` +
      (activity.ongoingTasks
        .slice(0, 8)
        .map((t) => `"${t.title}" (${t.assigneeName ?? "unassigned"}, ${TASK_STATUS_LABELS[t.status]})`)
        .join("; ") || "none") +
      "."
  );
  const expected = [
    ...activity.expectedTasks.map((t) => `task "${t.title}" due ${t.due_date}`),
    ...activity.expectedProjects.map((p) => `project "${p.name}" due ${p.due_date}`),
  ];
  lines.push(`Due within 14 days (${expected.length}): ${expected.slice(0, 8).join("; ") || "nothing"}.`);
  lines.push(`Detected challenges: ${challengesSummary}.`);
  if (activity.overdueTasks.length)
    lines.push(`Overdue tasks: ${activity.overdueTasks.slice(0, 6).map((t) => `"${t.title}"`).join(", ")}.`);
  if (activity.blockedTasks.length)
    lines.push(`Blocked tasks: ${activity.blockedTasks.slice(0, 6).map((t) => `"${t.title}"`).join(", ")}.`);
  if (activity.unassignedTasks.length)
    lines.push(`Unassigned tasks: ${activity.unassignedTasks.slice(0, 6).map((t) => `"${t.title}"`).join(", ")}.`);
  if (activity.overdueProjects.length)
    lines.push(`Overdue projects: ${activity.overdueProjects.slice(0, 6).map((p) => `"${p.name}"`).join(", ")}.`);
  const userPrompt = lines.join("\n");

  let confidence =
    snapshot && activity.tasks.length ? "high" : snapshot || activity.tasks.length ? "medium" : "low";
  let actionPlan = "";

  try {
    actionPlan = await anthropicMessages({
      model,
      system: ACTION_PLAN_SYSTEM_PROMPT,
      user: userPrompt,
      maxTokens: 900,
    });
    if (!actionPlan) throw new Error("empty response");
  } catch (e) {
    // Never invent a plan on failure — store an honest note.
    confidence = "insufficient";
    actionPlan = `Could not generate an action plan (${
      e instanceof Error ? e.message : "unknown error"
    }). The live Ongoing Tasks, Expected Outputs, and Challenges above still reflect real data — try again shortly.`;
  }

  await client.from("department_briefings").insert({
    org_id: orgId,
    department_id: departmentId,
    action_plan: actionPlan,
    challenges_summary: challengesSummary,
    data_confidence: confidence,
    model,
    generated_by: generatedBy,
  });
  return {
    status: actionPlan && confidence !== "insufficient" ? "generated" : "error",
    data_confidence: confidence,
  };
}
