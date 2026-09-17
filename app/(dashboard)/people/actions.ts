"use server";

import { revalidatePath } from "next/cache";
import { isProbationary, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  canManageProbation,
  DECISION_STATUS,
  type ProbationDecision,
  type ProbationSubject,
} from "@/lib/people/probation";
import { notifyProbationDecision } from "@/lib/notifications/producers";
import { writeAudit } from "@/lib/audit/log";
import type { UserRole } from "@/types/database";

const ROLES: UserRole[] = ["ceo", "coo", "department_head", "team_member"];

// People is the master source of truth for contractor information. This is the
// single write path behind "Edit Contractor Information": leadership (ceo / coo)
// only — matching the users_update_as_admin RLS policy — and the ONLY place a
// contractor's professional / personal / pay fields are stored. Every other HR
// view reads these by join, so one edit here propagates everywhere.

type DbErr = { message: string; code?: string } | null;
type DbShim = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => {
      eq: (c: string, val: string) => Promise<{ error: DbErr }>;
    };
  };
};

export type ContractorFormState = { ok: boolean; error?: string };

const DEFAULT_EMPLOYMENT_STATUS = "Independent Contractor";

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

// Optional string → value or null (so a cleared field writes NULL, not "").
function strOrNull(fd: FormData, key: string): string | null {
  const v = str(fd, key);
  return v || null;
}

function numOrNull(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(fd: FormData, key: string): string | null {
  const v = str(fd, key);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// A Telegram handle stored WITHOUT the leading @ (the mention builder adds it),
// so "@jane", "jane" and " jane " all normalise to "jane". Cleared → NULL.
function telegramOrNull(fd: FormData, key: string): string | null {
  const v = str(fd, key).replace(/^@+/, "").trim();
  return v || null;
}

// useFormState-shaped: (prevState, formData) → state.
export async function updateContractor(
  _prev: ContractorFormState,
  formData: FormData
): Promise<ContractorFormState> {
  const profile = await requireRole(["ceo", "coo"]);
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Missing contractor id." };

  const fullName = str(formData, "full_name");
  if (!fullName) return { ok: false, error: "Full name is required." };

  const email = str(formData, "email");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "A valid email is required." };
  }

  const supabase = createServerSupabaseClient();

  // Contractor Code is unique per org (users_contractor_code_uidx). Pre-check for
  // a friendly message; the unique index is still the real guard below.
  const contractorCode = strOrNull(formData, "contractor_code");
  if (contractorCode) {
    const { data: dup } = await supabase
      .from("users")
      .select("id")
      .eq("org_id", profile.org_id)
      .eq("contractor_code", contractorCode)
      .neq("id", id)
      .maybeSingle();
    if (dup) {
      return { ok: false, error: `Contractor code "${contractorCode}" is already in use.` };
    }
  }

  const supervisorId = strOrNull(formData, "supervisor_id");
  const roleRaw = str(formData, "role");
  const role = (ROLES as string[]).includes(roleRaw) ? (roleRaw as UserRole) : undefined;

  const patch: Record<string, unknown> = {
    // Professional
    full_name: fullName,
    position: strOrNull(formData, "position"), // Job Title
    department_id: strOrNull(formData, "department_id"),
    ...(role ? { role } : {}),
    employment_status: strOrNull(formData, "employment_status") ?? DEFAULT_EMPLOYMENT_STATUS,
    date_started: dateOrNull(formData, "date_started"),
    // New-hire probation: when a hire is marked 'probationary', this end date is
    // what the session guard checks. A cleared field writes NULL (no gate).
    probation_end: dateOrNull(formData, "probation_end"),
    base_pay: numOrNull(formData, "base_pay"),
    commission_structure: strOrNull(formData, "commission_structure"),
    compensation_frequency: strOrNull(formData, "compensation_frequency"),
    supervisor_id: supervisorId === id ? null : supervisorId, // never self-supervise
    team_assignment: strOrNull(formData, "team_assignment"),
    contractor_code: contractorCode,
    // Personal
    mobile: strOrNull(formData, "mobile"),
    email,
    home_address: strOrNull(formData, "home_address"),
    emergency_contact_name: strOrNull(formData, "emergency_contact_name"),
    emergency_contact_number: strOrNull(formData, "emergency_contact_number"),
    telegram_username: telegramOrNull(formData, "telegram_username"),
    updated_at: new Date().toISOString(),
  };

  // Snapshot the fields we audit (role / employment_status) BEFORE the write, so
  // the trail can record an honest old→new. Org-scoped; a miss just yields nulls.
  const { data: before } = await supabase
    .from("users")
    .select("role, employment_status")
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .maybeSingle();
  const prev = (before as { role?: string | null; employment_status?: string | null } | null) ?? null;

  const { error } = await (supabase as unknown as DbShim)
    .from("users")
    .update(patch)
    .eq("id", id);

  if (error) {
    // 23505 = unique_violation (contractor_code or email raced past the pre-check).
    if (error.code === "23505") {
      return { ok: false, error: "That contractor code or email is already in use." };
    }
    return { ok: false, error: error.message || "Could not save changes." };
  }

  // Privileged-action trail — one row per field that actually changed. A role
  // change and an employment change are distinct events even in the same edit.
  const newEmployment = patch.employment_status as string;
  if (role && prev?.role && role !== prev.role) {
    await writeAudit({
      action: "role_change",
      entityType: "user",
      entityId: id,
      actorUserId: profile.id,
      actorRole: profile.role,
      orgId: profile.org_id,
      detail: { field: "role", from: prev.role, to: role },
    });
  }
  if ((prev?.employment_status ?? null) !== newEmployment) {
    await writeAudit({
      action: "employment_change",
      entityType: "user",
      entityId: id,
      actorUserId: profile.id,
      actorRole: profile.role,
      orgId: profile.org_id,
      detail: { field: "employment_status", from: prev?.employment_status ?? null, to: newEmployment },
    });
  }

  revalidatePath("/people");
  revalidatePath("/payroll");
  revalidatePath("/attendance");
  return { ok: true };
}

export type PromoteState = { ok: boolean; error?: string };

// "Make Permanent" — promotes a probationary hire to a permanent employee:
// sets employment_status='active', which clears the probation access gate (a
// suspended, past-probation user regains access immediately). Role is left
// untouched by design — promotion out of probation is not a role change.
//
// Authorized for leadership AND department heads (per the locked decision),
// which is broader than the users_update_as_admin RLS policy (ceo/coo only).
// We therefore perform the flip with the service-role client, but authorization
// is enforced here by requireRole and the write is scoped to the promoter's own
// org so tenant isolation still holds. This mirrors the codebase's existing
// pattern of using the service client only in a trusted, gated server action.
export async function makePermanent(
  _prev: PromoteState,
  formData: FormData
): Promise<PromoteState> {
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Missing contractor id." };

  const svc = createServiceRoleClient();
  const { data, error } = await (svc as unknown as {
    from: (t: string) => {
      update: (v: Record<string, unknown>) => {
        eq: (c: string, val: string) => {
          eq: (c: string, val: string) => {
            select: (cols: string) => Promise<{ data: unknown[] | null; error: DbErr }>;
          };
        };
      };
    };
  })
    .from("users")
    .update({ employment_status: "active", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .select("id");

  if (error) return { ok: false, error: error.message || "Could not update employment status." };
  if (!data || data.length === 0) {
    return { ok: false, error: "That person is no longer in your organization." };
  }

  // "Make Permanent" is an employment-status transition → probationary → active.
  await writeAudit({
    action: "employment_change",
    entityType: "user",
    entityId: id,
    actorUserId: profile.id,
    actorRole: profile.role,
    orgId: profile.org_id,
    detail: { field: "employment_status", from: "probationary", to: "active", reason: "make_permanent" },
  });

  revalidatePath("/people");
  return { ok: true };
}

// --- Probation lifecycle decisions ------------------------------------------
// The HR-facing decision spine behind the Probation queue. Each decision (a)
// transitions users.employment_status, (b) appends ONE probation_reviews ledger
// row, and (c) fans a best-effort notification to the hire's supervisor + the
// hire. All three writes go through the SERVICE-ROLE client because the gate is
// broader than the users_update_as_admin RLS policy (leadership only) — it also
// admits the HR & Admin department head — and probation_reviews has no RLS
// policy at all (service-role only, by design). Authorization is enforced HERE
// by requireRole + canManageProbation, and every write is scoped to the actor's
// own org so tenant isolation still holds. Release is a SOFT transition
// (status='released'); the user row is never hard-deleted.

export type ProbationDecisionState = { ok: boolean; error?: string };

type SvcErr = { message: string; code?: string } | null;
type Svc = { from: (t: string) => any };

// Read the subject once (service-role, org-scoped) and confirm they're still a
// probationary member of the actor's org. Returns a friendly error string
// otherwise so the caller can surface it without a second round-trip.
async function loadProbationSubject(
  svc: Svc,
  orgId: string,
  id: string
): Promise<{ subject?: ProbationSubject; error?: string }> {
  const { data } = await svc
    .from("users")
    .select("id, org_id, full_name, email, employment_status, probation_end, supervisor_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  const subject = (data as ProbationSubject | null) ?? null;
  if (!subject) return { error: "That person is no longer in your organization." };
  if (!isProbationary(subject.employment_status)) {
    return { error: "That person is not on probation anymore — refresh the queue." };
  }
  return { subject };
}

// The shared core: gate → load subject → transition status (when the decision
// changes it) and/or move probation_end → append the ledger row → notify. The
// ledger insert is the source of truth, so its failure fails the action; the
// notification is best-effort and never blocks.
async function recordProbationDecision(
  formData: FormData,
  decision: ProbationDecision,
  buildPatch: (subject: ProbationSubject) => {
    patch: Record<string, unknown>;
    newProbationEnd: string | null;
    error?: string;
  }
): Promise<ProbationDecisionState> {
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const id = str(formData, "id");
  if (!id) return { ok: false, error: "Missing person id." };

  // The precise gate: leadership OR the HR & Admin head. A non-HR department
  // head is rejected here even though requireRole let them through.
  const rls = createServerSupabaseClient() as unknown as Svc;
  const allowed = await canManageProbation(rls, profile);
  if (!allowed) return { ok: false, error: "You don't have access to manage probation." };

  const svc = createServiceRoleClient() as unknown as Svc;
  const { subject, error: loadErr } = await loadProbationSubject(svc, profile.org_id, id);
  if (!subject) return { ok: false, error: loadErr };

  const { patch, newProbationEnd, error: patchErr } = buildPatch(subject);
  if (patchErr) return { ok: false, error: patchErr };
  const note = strOrNull(formData, "note");

  // Transition the user row (org-scoped) when there's anything to change.
  if (Object.keys(patch).length > 0) {
    const { data, error } = await svc
      .from("users")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("org_id", profile.org_id)
      .select("id");
    if (error) return { ok: false, error: (error as SvcErr)?.message || "Could not update employment status." };
    if (!data || (data as unknown[]).length === 0) {
      return { ok: false, error: "That person is no longer in your organization." };
    }
  }

  // Append the ledger row — the durable record of the decision.
  const { error: ledgerErr } = await svc.from("probation_reviews").insert({
    org_id: profile.org_id,
    user_id: subject.id,
    decision,
    previous_probation_end: subject.probation_end,
    new_probation_end: newProbationEnd,
    note,
    decided_by: profile.id,
  });
  if (ledgerErr) {
    return { ok: false, error: (ledgerErr as SvcErr)?.message || "Could not record the decision." };
  }

  // Privileged-action trail — the decision (regularize / extend / release) lives
  // in detail, alongside the probation_end old→new.
  await writeAudit({
    action: "probation_decision",
    entityType: "user",
    entityId: subject.id,
    actorUserId: profile.id,
    actorRole: profile.role,
    orgId: profile.org_id,
    detail: {
      decision,
      probation_end_from: subject.probation_end,
      probation_end_to: newProbationEnd,
      ...(note ? { note } : {}),
    },
  });

  // Notify the supervisor + the hire (best-effort — never blocks the decision).
  await notifyProbationDecision(
    {
      orgId: profile.org_id,
      userId: subject.id,
      personName: subject.full_name,
      decision,
      supervisorId: subject.supervisor_id,
      newProbationEnd,
      note,
    },
    svc
  );

  revalidatePath("/people");
  revalidatePath("/people/probation");
  return { ok: true };
}

// Regularize — probation passed. Status → 'active' (matching the "Make
// Permanent" path); ledger records the prior probation_end. The old date is left
// on the row (harmless once non-probationary) as the historical record of when
// probation had been set to end.
export async function regularizeProbation(
  _prev: ProbationDecisionState,
  formData: FormData
): Promise<ProbationDecisionState> {
  return recordProbationDecision(formData, "regularize", () => ({
    patch: { employment_status: DECISION_STATUS.regularize },
    newProbationEnd: null,
  }));
}

// Extend — more runway. Status stays 'probationary'; probation_end moves to the
// picked date (must be a valid date, today or later). Ledger records both the
// previous and the new end date.
export async function extendProbation(
  _prev: ProbationDecisionState,
  formData: FormData
): Promise<ProbationDecisionState> {
  const newEnd = dateOrNull(formData, "new_probation_end");
  return recordProbationDecision(formData, "extend", () => {
    if (!newEnd) {
      return { patch: {}, newProbationEnd: null, error: "Pick a valid new probation end date." };
    }
    const today = new Date().toISOString().slice(0, 10);
    if (newEnd < today) {
      return { patch: {}, newProbationEnd: null, error: "The new end date can't be in the past." };
    }
    return { patch: { probation_end: newEnd }, newProbationEnd: newEnd };
  });
}

// Release — probation not passed. Status → 'released' (a SOFT archive: the user
// row and all their history stay intact). Ledger records the prior probation_end.
export async function releaseProbation(
  _prev: ProbationDecisionState,
  formData: FormData
): Promise<ProbationDecisionState> {
  return recordProbationDecision(formData, "release", () => ({
    patch: { employment_status: DECISION_STATUS.release },
    newProbationEnd: null,
  }));
}
