"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { sanitizeText } from "@/lib/security/sanitize";
import { manilaToday } from "@/lib/hr/time";

export type LogEntryState = { ok: boolean; error?: string };

type Db = { from: (table: string) => any };

// "+ Log entry" appends one line to today's daily report rather than creating a
// second record. The schema is one report per org+user+work_date, and
// submitCompanyDailyReport upserts on that key -- writing a separate row here
// would collide with it and lose whichever wrote second.
//
// The entry lands as a DRAFT. Logging is not filing: "File daily report" is the
// act that submits, and keeping them apart means a half-written day is never
// mistaken for a submitted one.
export async function addLogEntry(
  _prev: LogEntryState,
  formData: FormData
): Promise<LogEntryState> {
  const profile = await requireProfile();

  const entry = sanitizeText(formData.get("entry"), 500).trim();
  if (entry.length < 3) {
    return { ok: false, error: "Write what you did before logging it." };
  }
  // One entry is one line, so a pasted newline would silently become two.
  const line = entry.replace(/\s*\n+\s*/g, " ");

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;
  const workDate = manilaToday();

  try {
    const { data: existing } = await db
      .from("daily_reports")
      .select("id, outputs, status")
      .eq("org_id", profile.org_id)
      .eq("user_id", profile.id)
      .eq("work_date", workDate)
      .maybeSingle();

    const row = existing as { id: string; outputs: string | null; status: string } | null;
    const outputs = [row?.outputs?.trim(), line].filter(Boolean).join("\n");

    const { error } = await db.from("daily_reports").upsert(
      {
        org_id: profile.org_id,
        user_id: profile.id,
        department_id: profile.department_id,
        work_date: workDate,
        outputs,
        // A report already submitted keeps its status: appending to a filed day
        // must not quietly reopen it.
        status: row?.status === "submitted" ? "submitted" : "draft",
      },
      { onConflict: "org_id,user_id,work_date" }
    );

    if (error) return { ok: false, error: error.message || "Could not save that entry." };
  } catch {
    return { ok: false, error: "Could not reach the log right now." };
  }

  revalidatePath("/team-workspace");
  return { ok: true };
}
