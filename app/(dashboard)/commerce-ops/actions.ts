"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";
import {
  DETAIL_FIELDS,
  RECORD_TYPE_SINGULAR,
  SOURCE_MODULE,
  isDepartment,
  isLeadership,
  isRecordType,
  type RecordType,
} from "@/lib/commerce-ops/records";
import { notifyPendingApproval } from "@/lib/notifications/producers";

// Server actions for Operational Records + Roll-Down. The workflow REUSES the
// existing Action & Approval spine (action_requests + action_audit):
//   • submit  → drafts an action_request for a human to approve (system
//               producer via the service-role client, because RLS only lets
//               leadership INSERT action_requests — a team_member never could).
//   • decide  → flips that action_request through the SAME ar_update policy the
//               Approval Queue uses, then moves the op_record (the DB guard
//               trigger keeps approve/reject leadership-only), and the op_record
//               audit trigger records the transition in action_audit.
//   • rolldown→ writes op_record_routing rows + in-app notifications (events)
//               and logs the roll-down in action_audit.
// Money is NEVER moved: budget/reward values live in details and are only
// recorded + routed for a human to act on.

// The op_records / action_requests / action_audit / events tables aren't in the
// generated Database types, so they're reached through the same cast shim used
// across the app (Live, Contracts, Approvals).
type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

const ALL_ROLES = ["ceo", "coo", "department_head", "team_member"] as const;

function userDb(): Shim {
  return createServerSupabaseClient() as unknown as Shim;
}
function serviceDb(): Shim {
  return createServiceRoleClient() as unknown as Shim;
}

function s(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

// Build the type-specific details jsonb from the submitted form. money/number
// fields are stored as numbers (or omitted); everything else as trimmed text.
function parseDetails(type: RecordType, formData: FormData): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  for (const f of DETAIL_FIELDS[type]) {
    const raw = s(formData, `d_${f.key}`);
    if (!raw) continue;
    if (f.kind === "money" || f.kind === "number") {
      const n = Number(raw.replace(/[₱,\s]/g, ""));
      if (!Number.isNaN(n)) details[f.key] = n;
    } else {
      details[f.key] = raw;
    }
  }
  return details;
}

function revalidate() {
  revalidatePath("/commerce-ops");
  revalidatePath("/approvals");
  revalidatePath("/notifications");
}

// ── Create / edit ─────────────────────────────────────────────────────────────
export async function createOpRecord(formData: FormData): Promise<void> {
  const profile = (await requireRole([...ALL_ROLES])) as unknown as Profile;
  const type = s(formData, "record_type");
  const title = s(formData, "title");
  if (!isRecordType(type) || !title) return;

  const db = userDb();
  await db.from("op_records").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    record_type: type,
    title,
    brand_id: s(formData, "brand_id") || null,
    assigned_team: s(formData, "assigned_team") || null,
    start_date: s(formData, "start_date") || null,
    end_date: s(formData, "end_date") || null,
    details: parseDetails(type, formData),
    status: "draft",
  });
  revalidate();
}

export async function updateOpRecord(formData: FormData): Promise<void> {
  const profile = (await requireRole([...ALL_ROLES])) as unknown as Profile;
  const id = s(formData, "id");
  const type = s(formData, "record_type");
  if (!id || !isRecordType(type)) return;

  const db = userDb();
  const { data: existing } = await db
    .from("op_records")
    .select("id, status, created_by")
    .eq("id", id)
    .maybeSingle();
  const row = existing as { id: string; status: string; created_by: string | null } | null;
  if (!row) return;

  // Edit-after-submit only by permission: a record still in draft or sent back
  // for revision is freely editable; once submitted/approved only leadership may
  // edit it. (RLS keeps it org-scoped; this is the workflow gate.)
  const openForEdit = row.status === "draft" || row.status === "revision_requested";
  if (!openForEdit && !isLeadership(profile.role)) return;

  await db
    .from("op_records")
    .update({
      title: s(formData, "title") || undefined,
      brand_id: s(formData, "brand_id") || null,
      assigned_team: s(formData, "assigned_team") || null,
      start_date: s(formData, "start_date") || null,
      end_date: s(formData, "end_date") || null,
      details: parseDetails(type, formData),
    })
    .eq("id", id);
  revalidate();
}

// ── Submit for approval → drafts an action_request on the shared spine ────────
export async function submitOpRecord(formData: FormData): Promise<void> {
  const profile = (await requireRole([...ALL_ROLES])) as unknown as Profile;
  const id = s(formData, "id");
  if (!id) return;

  const db = userDb();
  const { data: rec } = await db
    .from("op_records")
    .select("id, title, record_type, status, org_id")
    .eq("id", id)
    .maybeSingle();
  const record = rec as
    | { id: string; title: string; record_type: RecordType; status: string; org_id: string }
    | null;
  if (!record) return;
  if (record.status !== "draft" && record.status !== "revision_requested") return;

  // Move the record into 'submitted' (audit trigger logs the transition).
  const { error: updErr } = await db
    .from("op_records")
    .update({ status: "submitted" })
    .eq("id", id)
    .in("status", ["draft", "revision_requested"]);
  if (updErr) return;

  // Draft the approval request on the shared spine. RLS blocks a team_member
  // from inserting action_requests, so — like every other producer in the OS —
  // this runs as the system via the service-role client, stamping org_id from
  // the caller's verified profile.
  const svc = serviceDb();

  // Idempotency: don't stack a second open request on the same record.
  const { data: open } = await svc
    .from("action_requests")
    .select("id")
    .eq("source_module", SOURCE_MODULE)
    .eq("source_ref->>op_record_id", id)
    .in("status", ["pending", "approved"])
    .limit(1);
  if (Array.isArray(open) && open.length > 0) {
    revalidate();
    return;
  }

  const label = RECORD_TYPE_SINGULAR[record.record_type];
  const { data: inserted } = await svc
    .from("action_requests")
    .insert({
      org_id: profile.org_id,
      source_module: SOURCE_MODULE,
      source_ref: { op_record_id: id, record_type: record.record_type },
      title: `Approve ${label}: ${record.title}`,
      problem: `A ${label} was submitted for leadership approval.`,
      recommendation: `Review "${record.title}" and approve, reject, or request a revision.`,
      risk_tier: 2,
      required_role: "department_head",
      proposed_action: null, // recommendation-only — approval unlocks Roll-Down; nothing auto-executes
      status: "pending",
      created_by: profile.id,
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
      detail: { source: SOURCE_MODULE, op_record_id: id, submitted_by: profile.id },
    });
    // Notify the approvers (leadership + department heads) that a decision is
    // waiting — points at the action_request so the centre offers Approve/View.
    await notifyPendingApproval(
      {
        orgId: profile.org_id,
        title: `Approve ${label}: ${record.title}`,
        body: `A ${label} was submitted for leadership approval.`,
        requiredRole: "department_head",
        actionRequestId: inserted.id,
      },
      svc
    );
  }
  revalidate();
}

// ── Decide: approve / reject / request revision (leadership only) ─────────────
export async function decideOpRecord(formData: FormData): Promise<void> {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const id = s(formData, "id");
  const decision = s(formData, "decision"); // approved | rejected | revision_requested
  const note = s(formData, "note") || null;
  if (!id || !["approved", "rejected", "revision_requested"].includes(decision)) return;

  const db = userDb();

  // Find the open request for this record on the shared spine and decide it
  // through the SAME ar_update RLS policy the Approval Queue uses.
  const { data: reqRow } = await db
    .from("action_requests")
    .select("id, org_id, status")
    .eq("source_module", SOURCE_MODULE)
    .eq("source_ref->>op_record_id", id)
    .in("status", ["pending"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const req = reqRow as { id: string; org_id: string; status: string } | null;

  const decidedAt = new Date().toISOString();
  const arStatus = decision === "approved" ? "approved" : "rejected"; // spine has no 'revision' state
  const arNote = decision === "revision_requested" ? `[revision requested] ${note ?? ""}`.trim() : note;

  if (req) {
    const { data: updated } = await db
      .from("action_requests")
      .update({
        status: arStatus,
        decided_by: profile.id,
        decided_at: decidedAt,
        decision_note: arNote,
        updated_at: decidedAt,
      })
      .eq("id", req.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    // The spine decision row (event 'approved'/'rejected') is written at the DB
    // by tg_action_decision_audit on the pending→decided transition; the
    // op_record's own status change is audited separately below. void `updated`.
    void updated;
  }

  // Move the op_record. The DB guard trigger keeps approve/reject leadership-only
  // even if some other path tried it; the audit trigger logs the transition.
  const patch: Record<string, unknown> =
    decision === "approved"
      ? { status: "approved", approved_by: profile.id, approved_at: decidedAt }
      : decision === "rejected"
        ? { status: "rejected" }
        : { status: "revision_requested" };

  await db.from("op_records").update(patch).eq("id", id).eq("status", "submitted");
  revalidate();
}

// ── Mark completed (after approval) ──────────────────────────────────────────
export async function completeOpRecord(formData: FormData): Promise<void> {
  await requireRole([...ALL_ROLES]);
  const id = s(formData, "id");
  if (!id) return;
  const db = userDb();
  await db.from("op_records").update({ status: "completed" }).eq("id", id).eq("status", "approved");
  revalidate();
}

// ── Roll Down to Connected Department(s) ─────────────────────────────────────
export async function rollDownOpRecord(formData: FormData): Promise<void> {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const id = s(formData, "id");
  const departments = formData.getAll("departments").map((d) => String(d)).filter(isDepartment);
  if (!id || departments.length === 0) return;

  const db = userDb();
  const { data: rec } = await db
    .from("op_records")
    .select("id, title, record_type, status, org_id")
    .eq("id", id)
    .maybeSingle();
  const record = rec as
    | { id: string; title: string; record_type: RecordType; status: string; org_id: string }
    | null;
  if (!record || record.status !== "approved") return; // Roll-Down unlocks only on approval

  // Skip departments already routed for this record (idempotent re-routing).
  const { data: existing } = await db
    .from("op_record_routing")
    .select("department")
    .eq("op_record_id", id);
  const already = new Set(
    ((existing as { department: string }[] | null) ?? []).map((r) => r.department)
  );
  const fresh = departments.filter((d) => !already.has(d));
  if (fresh.length === 0) {
    revalidate();
    return;
  }

  await db.from("op_record_routing").insert(
    fresh.map((department) => ({
      org_id: profile.org_id,
      op_record_id: id,
      department,
      routed_by: profile.id,
    }))
  );

  // Generate in-app notifications (events feed) and log the roll-down in
  // action_audit. events INSERT is leadership-gated by RLS and this action is
  // leadership-only, but we write through the service client so the notification
  // fan-out never fails on an edge policy — org_id comes from the profile.
  const svc = serviceDb();
  const label = RECORD_TYPE_SINGULAR[record.record_type];
  await svc.from("events").insert(
    fresh.map((department) => ({
      org_id: profile.org_id,
      created_by: profile.id,
      scope: "org",
      kind: "alert",
      severity: "info",
      title: `Roll-down · ${label} "${record.title}" → ${department}`,
      body: `An approved ${label} was routed to ${department} for action. Acknowledge receipt in Commerce Ops → Operational Records.`,
    }))
  );
  try {
    await svc.from("action_audit").insert({
      org_id: profile.org_id,
      action_request_id: null,
      event: "op_record.routed",
      actor_id: profile.id,
      actor_role: profile.role,
      detail: { op_record_id: id, departments: fresh },
    });
  } catch {
    // Recording the trail must never break the roll-down it describes.
  }
  revalidate();
}

// ── Acknowledge a roll-down (the receiving department confirms receipt) ───────
export async function acknowledgeRouting(formData: FormData): Promise<void> {
  const profile = (await requireRole([...ALL_ROLES])) as unknown as Profile;
  const routingId = s(formData, "routing_id");
  if (!routingId) return;
  const db = userDb();
  await db
    .from("op_record_routing")
    .update({
      acknowledged: true,
      acknowledged_by: profile.id,
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", routingId)
    .eq("acknowledged", false);
  revalidate();
}
