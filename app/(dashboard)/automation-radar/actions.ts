"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import { getPatternById } from "@/lib/automation-radar/data";

// Server actions for the Automation Radar row actions. The workflow REUSES the
// shared Action & Approval spine (action_requests + action_audit):
//   • propose  → drafts a PENDING action_request (system producer via the
//                service-role client, because RLS only lets leadership INSERT
//                action_requests) and flips the pattern to 'proposed'.
//   • keepHuman→ marks the pattern 'keep_human' so it's never put up for automation.
//   • dismiss  → marks the pattern 'dismissed'.
// NOTHING executes: proposed_action is null (recommendation-only). Execution
// wiring is Phase 2. Team members can propose/dismiss for their OWN department;
// RLS + the guard trigger enforce that — approving/automating is leadership-only.

type Shim = { from: (t: string) => any };

function userDb(): Shim {
  return createServerSupabaseClient() as unknown as Shim;
}
function serviceDb(): Shim {
  return createServiceRoleClient() as unknown as Shim;
}

const SOURCE_MODULE = "automation_radar";

function revalidate(department: string | null) {
  revalidatePath("/automation-radar");
  revalidatePath("/approvals");
  revalidatePath("/employee");
  // The per-department panel lives on the dynamic department route; revalidate the
  // segment so the caller's next view reflects the change.
  revalidatePath("/department/[id]", "page");
  if (department) revalidatePath(`/department/${department}`);
}

// ── Propose automation → drafts a pending action_request on the shared spine ──
export async function proposeAutomation(formData: FormData): Promise<void> {
  const profile = await requireProfile();
  const id = String(formData.get("pattern_id") ?? "").trim();
  if (!id) return;

  const db = userDb();
  const pattern = await getPatternById(db, id);
  if (!pattern) return;
  // Judgment-heavy patterns are never automated — refuse to propose them.
  if (pattern.automatability === "keep_human") return;

  const svc = serviceDb();

  // Idempotency: don't stack a second open request on the same pattern.
  const { data: open } = await svc
    .from("action_requests")
    .select("id")
    .eq("source_module", SOURCE_MODULE)
    .eq("source_ref->>pattern_id", id)
    .in("status", ["pending", "approved"])
    .limit(1);
  if (Array.isArray(open) && open.length > 0) {
    // Still reflect the human's intent on the pattern.
    await db.from("repetition_patterns").update({ status: "proposed" }).eq("id", id);
    revalidate(pattern.department);
    return;
  }

  const title = pattern.normalized_title
    ? `Automate: ${pattern.normalized_title}`
    : "Automate a repeated task";
  const cadence = pattern.cadence ?? "recurring";
  const dept = pattern.department ?? "unassigned";

  const { data: inserted } = await svc
    .from("action_requests")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      source_module: SOURCE_MODULE,
      source_ref: {
        pattern_id: pattern.id,
        pattern_key: pattern.pattern_key,
        department: pattern.department,
        automatability: pattern.automatability,
        matched_capability_id: pattern.matched_capability_id,
        matched_workflow: pattern.matched_workflow,
      },
      title,
      problem: `"${pattern.normalized_title}" recurs ${cadence} in ${dept} — ~${pattern.occurrences} times, about ${pattern.time_cost_per_month ?? 0} min/month.`,
      recommendation:
        pattern.suggested_path ?? "Review this repeated work and decide how to automate it.",
      risk_tier: 2,
      required_role: "department_head",
      // recommendation-only — approval records the decision; execution is Phase 2.
      proposed_action: null,
      status: "pending",
    })
    .select("id")
    .single();

  if (inserted?.id) {
    await writeActionAudit(svc, {
      org_id: profile.org_id,
      action_request_id: inserted.id,
      event: "created",
      actor_id: null,
      actor_role: "system",
      detail: { source: SOURCE_MODULE, pattern_id: id, proposed_by: profile.id },
    });
  }

  // Flip the pattern to 'proposed' (RLS: leader anywhere, or a team member for
  // their own department; the guard trigger keeps approved/automated leadership-only).
  await db.from("repetition_patterns").update({ status: "proposed" }).eq("id", id);
  revalidate(pattern.department);
}

// ── Keep human → mark the pattern as needing a human each run (never automated) ─
export async function keepHuman(formData: FormData): Promise<void> {
  await requireProfile();
  const id = String(formData.get("pattern_id") ?? "").trim();
  if (!id) return;
  const db = userDb();
  const pattern = await getPatternById(db, id);
  if (!pattern) return;
  await db
    .from("repetition_patterns")
    .update({
      automatability: "keep_human",
      suggested_path: "Keep human — flagged as needing a judgment call each run.",
    })
    .eq("id", id);
  revalidate(pattern.department);
}

// ── Dismiss → not worth automating; hide from the radar ───────────────────────
export async function dismissPattern(formData: FormData): Promise<void> {
  await requireProfile();
  const id = String(formData.get("pattern_id") ?? "").trim();
  if (!id) return;
  const db = userDb();
  const pattern = await getPatternById(db, id);
  if (!pattern) return;
  await db.from("repetition_patterns").update({ status: "dismissed" }).eq("id", id);
  revalidate(pattern.department);
}
