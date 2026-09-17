"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isRequestType, LEAVE_TYPES } from "@/lib/hr/requests";
import { manilaToday } from "@/lib/hr/time";
import { sanitizeText } from "@/lib/security/sanitize";

// Server actions consumed by the Daily Logs CLIENT components (the request form
// and the daily-report form). Page-rendered forms keep their actions inline in
// page.tsx; only the two that live inside "use client" components need to be
// importable, so they live here behind "use server".

type DbErr = { message: string; code?: string } | null;
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<{ data: unknown; error: DbErr }>;
    upsert: (
      v: Record<string, unknown>,
      opts?: Record<string, unknown>
    ) => Promise<{ error: DbErr }>;
    update: (v: Record<string, unknown>) => {
      match: (q: Record<string, unknown>) => Promise<{ error: DbErr }>;
    };
  };
};

export type RequestFormState = { ok: boolean; error?: string };

function str(fd: FormData, k: string): string {
  return String(fd.get(k) ?? "").trim();
}
function strOrNull(fd: FormData, k: string): string | null {
  return str(fd, k) || null;
}
function numOrNull(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dateOrNull(fd: FormData, k: string): string | null {
  const v = str(fd, k);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function timeOrNull(fd: FormData, k: string): string | null {
  const v = str(fd, k);
  return /^\d{2}:\d{2}(:\d{2})?$/.test(v) ? v : null;
}

// File an online request into daily_log_requests. Requesters file their OWN
// requests (RLS: user_id = auth.uid()); it lands `pending` for a supervisor /
// leadership decision. Only the columns relevant to the chosen type are set.
export async function fileRequest(
  _prev: RequestFormState,
  formData: FormData
): Promise<RequestFormState> {
  const profile = await requireProfile();
  const type = str(formData, "request_type");
  if (!isRequestType(type)) return { ok: false, error: "Pick a request type." };

  const row: Record<string, unknown> = {
    org_id: profile.org_id,
    user_id: profile.id,
    request_type: type,
    status: "pending",
  };

  switch (type) {
    case "leave": {
      const leave = str(formData, "leave_type");
      if (!(LEAVE_TYPES as readonly string[]).includes(leave)) {
        return { ok: false, error: "Pick a leave type." };
      }
      row.leave_type = leave;
      row.work_date = dateOrNull(formData, "work_date");
      row.reason = strOrNull(formData, "reason");
      if (!row.work_date) return { ok: false, error: "Leave needs a date." };
      break;
    }
    case "overtime": {
      row.work_date = dateOrNull(formData, "work_date");
      row.start_time = timeOrNull(formData, "start_time");
      row.end_time = timeOrNull(formData, "end_time");
      row.total_hours = numOrNull(formData, "total_hours");
      row.reason = strOrNull(formData, "reason");
      if (!row.work_date) return { ok: false, error: "Overtime needs a work date." };
      break;
    }
    case "undertime": {
      row.work_date = dateOrNull(formData, "work_date");
      row.time_out = timeOrNull(formData, "time_out");
      row.reason = strOrNull(formData, "reason");
      if (!row.work_date) return { ok: false, error: "Undertime needs a work date." };
      break;
    }
    case "ooo": {
      row.work_date = dateOrNull(formData, "work_date");
      row.duration = strOrNull(formData, "duration");
      row.purpose = strOrNull(formData, "purpose");
      row.expected_return = dateOrNull(formData, "expected_return");
      if (!row.work_date) return { ok: false, error: "OOO needs a work date." };
      break;
    }
    case "rest_day_duty": {
      row.work_date = dateOrNull(formData, "work_date");
      row.total_hours = numOrNull(formData, "total_hours");
      row.reason = strOrNull(formData, "reason");
      if (!row.work_date) return { ok: false, error: "Rest day duty needs a work date." };
      break;
    }
    case "holiday_duty": {
      row.work_date = dateOrNull(formData, "work_date"); // holiday worked
      row.total_hours = numOrNull(formData, "total_hours"); // hours rendered
      row.remarks = strOrNull(formData, "remarks");
      if (!row.work_date) return { ok: false, error: "Holiday duty needs the holiday date." };
      break;
    }
  }

  const supabase = createServerSupabaseClient();
  const { error } = await (supabase as unknown as DbShim).from("daily_log_requests").insert(row);
  if (error) return { ok: false, error: error.message || "Could not file the request." };

  revalidatePath("/attendance");
  return { ok: true };
}

export type ReportFormState = { ok: boolean; error?: string };

// Submit a Daily Report: the deliverables the contractor completed for the day.
// The system validates completion (deliverables required) BEFORE it will mark
// the workday complete — it creates a `reports` row and stamps report_submitted
// / report_id onto that day's attendance. Attendance must reflect real work
// completion, not just a login.
export async function submitDailyReport(
  _prev: ReportFormState,
  formData: FormData
): Promise<ReportFormState> {
  const profile = await requireProfile();
  const workDate = dateOrNull(formData, "work_date") ?? manilaToday();
  // Strip any markup/control chars from the free-text report fields on write.
  const deliverables = sanitizeText(str(formData, "deliverables"));
  const summary = sanitizeText(str(formData, "summary"));

  // Completion validation: a report with no deliverables can't close a workday.
  if (deliverables.length < 3) {
    return { ok: false, error: "List the deliverables you completed before submitting." };
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as DbShim;

  const { data, error: insErr } = await db.from("reports").insert({
    org_id: profile.org_id,
    type: "daily",
    title: `Daily Report — ${profile.full_name} — ${workDate}`,
    period_start: workDate,
    period_end: workDate,
    generated_by: profile.id,
    content: {
      kind: "daily_report",
      work_date: workDate,
      user_id: profile.id,
      deliverables,
      summary: summary || null,
    },
  });
  if (insErr) return { ok: false, error: insErr.message || "Could not save the report." };

  const reportId = (data as { id?: string }[] | { id?: string } | null);
  // insert() without .select() returns null data on supabase-js; fetch the id back.
  let newReportId: string | null = null;
  if (Array.isArray(reportId) && reportId[0]?.id) newReportId = reportId[0].id!;
  else if (reportId && !Array.isArray(reportId) && reportId.id) newReportId = reportId.id;

  if (!newReportId) {
    const { data: found } = await supabase
      .from("reports")
      .select("id")
      .eq("generated_by", profile.id)
      .eq("period_end", workDate)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    newReportId = (found as { id: string } | null)?.id ?? null;
  }

  // Ensure the attendance row exists for the day, then mark it report-complete.
  const { error: upErr } = await db.from("attendance").upsert(
    {
      org_id: profile.org_id,
      user_id: profile.id,
      work_date: workDate,
      report_submitted: true,
      report_id: newReportId,
    },
    { onConflict: "user_id,work_date" }
  );
  if (upErr) return { ok: false, error: upErr.message || "Report saved, but the workday could not be marked complete." };

  revalidatePath("/attendance");
  revalidatePath("/reports");
  return { ok: true };
}
