"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manilaToday, isDate } from "@/lib/hr/time";
import { sanitizeText, sanitizeNullableText, safeUrl } from "@/lib/security/sanitize";

// Company-wide Daily Report — every role files one, from their role home.
//
// Filing a report is THE confirmation of task performance: the tasks tagged here
// become the single input to the scorecard's Efficiency (lib/metrics/signals).
// This action writes the report, its task tags (which confirm those tasks), and
// any evidence links, all under the caller's RLS-scoped client:
//   1. daily_reports  — one row per (org, user, work_date); resubmitting replaces
//      it (upsert), stamping status='submitted' + submitted_at.
//   2. daily_report_tasks — the tags (confirmed = true). Rewritten to exactly the
//      current selection each submit, so un-ticking a task withdraws it.
//   3. evidence_attachments — Evidence (2.1) hanging off the report via the
//      existing capture spine (entity_type='daily_report'). Links only here;
//      photo/video capture uses the mobile quick-entry route against the report.
//
// This is SEPARATE from the HR attendance report gate (reports + attendance):
// that closes an HR workday; this confirms task performance company-wide.

export type DailyReportState = { ok: boolean; error?: string; reportId?: string };

// Loose client shim for tables outside the generated types — the same read/write
// escape hatch the rest of the OS uses (Actions / Live / Contracts / *_briefings).
type Db = { from: (t: string) => any };

function str(fd: FormData, k: string): string {
  return String(fd.get(k) ?? "").trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function submitCompanyDailyReport(
  _prev: DailyReportState,
  formData: FormData
): Promise<DailyReportState> {
  const profile = await requireProfile();

  const workDate = (() => {
    const v = str(formData, "work_date");
    return isDate(v) ? v : manilaToday();
  })();

  // Free-text fields, sanitized on write (defense-in-depth against stored markup).
  const outputs = sanitizeText(formData.get("outputs"));
  const summary = sanitizeNullableText(formData.get("summary"));
  const blockers = sanitizeNullableText(formData.get("blockers"));

  // The tasks this report confirms — de-duplicated, UUID-validated.
  const taskIds = Array.from(
    new Set(formData.getAll("task_ids").map((v) => String(v).trim()).filter((v) => UUID_RE.test(v)))
  );

  // Substance guard: a report must record real work — the outputs completed, or
  // at least one confirmed task. An empty report can't confirm performance.
  if (outputs.length < 3 && taskIds.length === 0) {
    return {
      ok: false,
      error: "Record what you completed (outputs) or tag at least one task before submitting.",
    };
  }

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // ── 1. Upsert the report (one per org+user+work_date) ────────────────────────
  const { data: upserted, error: upErr } = await db
    .from("daily_reports")
    .upsert(
      {
        org_id: profile.org_id,
        user_id: profile.id,
        department_id: profile.department_id, // attribute by the filer's department
        work_date: workDate,
        summary,
        outputs: outputs || null,
        blockers,
        status: "submitted",
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "org_id,user_id,work_date" }
    )
    .select("id")
    .maybeSingle();
  if (upErr) return { ok: false, error: upErr.message || "Could not save the daily report." };

  let reportId = (upserted as { id: string } | null)?.id ?? null;
  if (!reportId) {
    // Some drivers return no row from upsert without a representation; read it back.
    const { data: found } = await db
      .from("daily_reports")
      .select("id")
      .eq("org_id", profile.org_id)
      .eq("user_id", profile.id)
      .eq("work_date", workDate)
      .maybeSingle();
    reportId = (found as { id: string } | null)?.id ?? null;
  }
  if (!reportId) return { ok: false, error: "Report saved, but its id could not be resolved." };

  // ── 2. Rewrite the task tags to exactly the current selection ────────────────
  // Delete-then-insert so un-ticking a task withdraws its confirmation. RLS keeps
  // this scoped to the caller's own report.
  await db.from("daily_report_tasks").delete().eq("report_id", reportId);
  if (taskIds.length > 0) {
    const tags = taskIds.map((task_id) => ({ report_id: reportId, task_id, confirmed: true }));
    const { error: tagErr } = await db.from("daily_report_tasks").insert(tags);
    if (tagErr) {
      return { ok: false, error: tagErr.message || "Report saved, but the task tags could not be recorded." };
    }
  }

  // ── 3. Attach evidence links (Evidence 2.1) ──────────────────────────────────
  // One URL per line. Each is validated to a safe http(s) scheme; junk lines are
  // skipped silently. Photo/video capture goes through the mobile quick-entry
  // route (entity_type='daily_report'); this covers the link case in-form.
  const links = Array.from(
    new Set(
      str(formData, "evidence_links")
        .split(/\r?\n/)
        .map((l) => safeUrl(l))
        .filter((l): l is string => !!l)
    )
  );
  if (links.length > 0) {
    const rows = links.map((url) => ({
      org_id: profile.org_id,
      entity_type: "daily_report",
      entity_id: reportId,
      url,
      kind: "link",
      source_url: url,
      uploaded_by: profile.id,
    }));
    // Best-effort: an evidence failure must not lose the confirmed report.
    await db.from("evidence_attachments").insert(rows);
  }

  revalidatePath("/");
  revalidatePath("/employee");
  revalidatePath("/metrics");
  return { ok: true, reportId };
}
