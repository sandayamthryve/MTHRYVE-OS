"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { sanitizeText } from "@/lib/security/sanitize";
// Not re-exported from here: a "use server" module may only export async
// functions, so the list lives in its own module and both sides import it.
import { LEAVE_TYPES } from "@/lib/hr/leave-types";

export type LeaveState = { ok: boolean; error?: string };

type Db = { from: (table: string) => any };

const DECIDERS = ["ceo", "coo", "department_head"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Inclusive span, so a single-day leave is 1 rather than 0.
function inclusiveDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.floor(ms / 86_400_000) + 1;
}

// ── File a request ──────────────────────────────────────────────────────────
// Always for yourself, always pending. RLS enforces both; this checks them too
// so the failure is a readable message rather than a policy rejection.
export async function fileLeaveRequest(
  _prev: LeaveState,
  formData: FormData
): Promise<LeaveState> {
  const profile = await requireProfile();

  const leaveType = sanitizeText(formData.get("leave_type"), 60).trim();
  const startDate = String(formData.get("start_date") ?? "").trim();
  const endDate = String(formData.get("end_date") ?? "").trim();
  const reason = sanitizeText(formData.get("reason"), 1000).trim();

  if (!(LEAVE_TYPES as readonly string[]).includes(leaveType)) {
    return { ok: false, error: "Choose a leave type." };
  }
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    return { ok: false, error: "Enter both a start and an end date." };
  }
  if (endDate < startDate) {
    return { ok: false, error: "The end date cannot be before the start date." };
  }
  if (reason.length < 3) {
    return { ok: false, error: "Give a reason for the request." };
  }

  const duration = inclusiveDays(startDate, endDate);
  // A year is the outer bound of anything worth filing through this form; past
  // that it is a leave of absence and belongs in a conversation, not a row.
  if (duration > 365) {
    return { ok: false, error: "That span is longer than a year — file this with HR directly." };
  }

  const db = createServerSupabaseClient() as unknown as Db;
  const { error } = await db.from("leave_requests").insert({
    org_id: profile.org_id,
    employee_id: profile.id,
    employee_name: profile.full_name,
    leave_type: leaveType,
    start_date: startDate,
    end_date: endDate,
    duration_days: duration,
    reason,
    status: "pending",
  });

  if (error) return { ok: false, error: error.message || "Could not file that request." };

  revalidatePath("/leave");
  return { ok: true };
}

// ── Decide a request ────────────────────────────────────────────────────────
// Leadership only, never your own, and only while it is still pending —
// deciding a request twice would overwrite the first decision silently.
export async function decideLeaveRequest(
  _prev: LeaveState,
  formData: FormData
): Promise<LeaveState> {
  const profile = await requireProfile();

  const id = String(formData.get("request_id") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const note = sanitizeText(formData.get("decision_note"), 500).trim();

  if (!id) return { ok: false, error: "Missing request." };
  if (decision !== "approved" && decision !== "rejected") {
    return { ok: false, error: "Unknown decision." };
  }
  if (!DECIDERS.includes(profile.role)) {
    return { ok: false, error: "Only leadership can decide leave requests." };
  }
  // A refusal without a reason cannot be reviewed later, so it is required.
  if (decision === "rejected" && note.length < 3) {
    return { ok: false, error: "Give a reason when rejecting a request." };
  }

  const db = createServerSupabaseClient() as unknown as Db;

  const { data: existing } = await db
    .from("leave_requests")
    .select("id, employee_id, status")
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .maybeSingle();

  const row = existing as { id: string; employee_id: string; status: string } | null;
  if (!row) return { ok: false, error: "That request no longer exists." };
  if (row.employee_id === profile.id) {
    return { ok: false, error: "You cannot decide your own leave request." };
  }
  if (row.status !== "pending") {
    return { ok: false, error: `That request was already ${row.status}.` };
  }

  const { error } = await db
    .from("leave_requests")
    .update({
      status: decision,
      approver_id: profile.id,
      approver_name: profile.full_name,
      decision_note: note || null,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("org_id", profile.org_id)
    // Re-assert pending in the write itself: between the read above and here,
    // someone else may have decided it.
    .eq("status", "pending");

  if (error) return { ok: false, error: error.message || "Could not record that decision." };

  revalidatePath("/leave");
  return { ok: true };
}

// ── Withdraw your own ───────────────────────────────────────────────────────
export async function cancelLeaveRequest(
  _prev: LeaveState,
  formData: FormData
): Promise<LeaveState> {
  const profile = await requireProfile();
  const id = String(formData.get("request_id") ?? "").trim();
  if (!id) return { ok: false, error: "Missing request." };

  const db = createServerSupabaseClient() as unknown as Db;
  const { error } = await db
    .from("leave_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", profile.org_id)
    .eq("employee_id", profile.id)
    .eq("status", "pending");

  if (error) return { ok: false, error: error.message || "Could not withdraw that request." };

  revalidatePath("/leave");
  return { ok: true };
}
