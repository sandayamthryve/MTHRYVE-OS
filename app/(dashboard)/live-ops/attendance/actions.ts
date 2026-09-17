"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Server actions for the contributor Attendance gate. Same DB-enforced
// authorization as the moderation gate: the moderator can only read/update a
// contributor_log whose brand they are assigned to (or if they are ceo/coo), so a
// successful RLS read == authorization. Attendance lives on its own
// attendance_status column, independent of the work-data `status`.

type Db = { from: (t: string) => any };

async function decideAttendance(id: string, decision: "approved" | "rejected", userId: string) {
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // Visible → authorized (contriblogs_read RLS). Otherwise abort.
  const { data: row } = await db.from("contributor_logs").select("id").eq("id", id).maybeSingle();
  if (!row) return;

  await db
    .from("contributor_logs")
    .update({
      attendance_status: decision,
      attendance_reviewed_by: userId,
      attendance_reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  revalidatePath("/live-ops/attendance");
}

export async function approveAttendance(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await decideAttendance(id, "approved", profile.id);
}

export async function rejectAttendance(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await decideAttendance(id, "rejected", profile.id);
}
