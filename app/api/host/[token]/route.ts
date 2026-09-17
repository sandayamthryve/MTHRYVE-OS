import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service";
import {
  resolveContributorByToken,
  getOrCreateTodayLogId,
  LIVE_OPS_SNAP_FIELDS,
} from "@/lib/contributors/tokens";
import { submitContributorReport } from "@/lib/contributors/report";
import { isVisionConfigured, readFields } from "@/lib/snapfill/vision";

export const runtime = "nodejs";
// Read env fresh each request (Vercel runtime-only vars) and never cache.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Public write endpoint for the token page (/host/<token>). It is reachable
// WITHOUT an OS session — the middleware exempts /api/host — so every request is
// re-validated here against the token, server-side, and EVERY write is scoped to
// the contributor_id + brand_id DERIVED FROM THE TOKEN. No client-supplied id is
// ever trusted. Writes go through the service-role client (contributor_logs has
// no anon insert policy by design; the token IS the credential).
//
// Actions:
//   clock_in  — selfie + clock_in_at (attendance stays 'pending')
//   task_note — the daily task note (on today's contributor_logs row)
//   snap      — Snap-to-Data: save the live-results photo → evidence_photo_path,
//               read ONLY whitelisted Live-Ops keys (viewers/gmv/ctor) →
//               extracted_metrics. status stays 'unverified'. NOTHING is written
//               to live_sessions or metric_entries here.
//   log_work  — the per-department daily report: writes daily_reports +
//               daily_report_tasks (confirmed) scoped to the contributor's own
//               org_id + department_id (see lib/contributors/report.ts), so the
//               work surfaces on their department dashboard. Live hosts still use
//               `snap` for results (promoted to live_sessions on moderator review).

const READABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

type Db = { from: (t: string) => any };

function bad(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: { token: string } }
) {
  try {
    return await handle(request, params.token);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Something went wrong — please try again." },
      { status: 200 }
    );
  }
}

async function handle(request: Request, token: string) {
  // 1) Re-validate the token → active contributor. This is the ONLY authority for
  //    who is writing and to which brand. An unknown / expired / revoked token
  //    gets a calm, non-technical message (200, not 404) that matches the /host
  //    expired screen — never a redirect and never the login rate limiter.
  const contributor = await resolveContributorByToken(token);
  if (!contributor)
    return bad("This link has expired. Ask your team lead to reissue it.", 200);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("Invalid submission.");
  }
  const action = String(form.get("action") ?? "").trim();

  // 2) Get (or create) today's log row for this contributor.
  const logId = await getOrCreateTodayLogId(contributor);
  if (!logId) return bad("Couldn't open today's log — please try again.", 200);

  const service = createServiceRoleClient();
  const db = service as unknown as Db;

  if (action === "task_note") {
    const note = String(form.get("note") ?? "").trim().slice(0, 4000);
    if (!note) return bad("Write a short note first.");
    await db
      .from("contributor_logs")
      .update({ task_note: note, updated_at: new Date().toISOString() })
      .eq("id", logId);
    return NextResponse.json({ ok: true, message: "Task note saved." });
  }

  // log_work — the per-department daily report. Writes a daily_reports row +
  // daily_report_tasks (confirmed) scoped to THIS contributor's own org_id +
  // department_id (both derived from the token, never the client), so the work
  // surfaces on their department dashboard. The contributor_log row above still
  // carries selfie/attendance/evidence; here we also mirror a compact note onto it
  // so the moderation/attendance queues keep showing what the contributor did.
  if (action === "log_work") {
    const outputs = String(form.get("outputs") ?? "").trim();
    const summary = String(form.get("summary") ?? "").trim();
    const blockers = String(form.get("blockers") ?? "").trim();
    const taskIds = form.getAll("task_ids").map((v) => String(v));
    const evidenceLinks = String(form.get("evidence_links") ?? "").split(/\r?\n/);

    const result = await submitContributorReport(contributor, {
      summary,
      outputs,
      blockers,
      taskIds,
      evidenceLinks,
    });
    if (!result.ok) return bad(result.error ?? "Couldn't submit — please try again.", 200);

    // Continuity: keep the day's contributor_log note in sync so the existing
    // moderation / attendance surfaces still reflect the contributor's own words.
    const note = [summary, outputs].filter(Boolean).join(" — ").slice(0, 4000);
    if (note) {
      await db
        .from("contributor_logs")
        .update({ task_note: note, updated_at: new Date().toISOString() })
        .eq("id", logId);
    }
    return NextResponse.json({ ok: true, message: "Submitted to your department. Thank you!" });
  }

  if (action === "clock_in" || action === "snap") {
    const file = form.get("image");
    if (!(file instanceof File) || file.size === 0) return bad("No photo received.");
    if (file.size > MAX_IMAGE_BYTES)
      return bad("That photo is too large — try again, it will be compressed.", 413);
    const mediaType = file.type || "image/jpeg";
    if (!READABLE.has(mediaType)) return bad("Unsupported image type.", 415);

    const buf = Buffer.from(await file.arrayBuffer());
    const kind = action === "clock_in" ? "selfie" : "evidence";
    const path = `${contributor.org_id}/contributors/${contributor.id}/${logId}/${kind}_${Date.now()}.jpg`;
    const { error: upErr } = await service.storage
      .from("evidence")
      .upload(path, buf, { contentType: mediaType, upsert: false });
    if (upErr) return bad("Couldn't save the photo — please try again.", 200);

    if (action === "clock_in") {
      await db
        .from("contributor_logs")
        .update({
          selfie_path: path,
          clock_in_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", logId);
      return NextResponse.json({ ok: true, message: "Clocked in — selfie saved." });
    }

    // action === "snap": save the photo, then read ONLY the whitelisted Live-Ops
    // keys off it. The reading stays 'unverified' until a moderator approves it.
    let extracted: Record<string, unknown> | null = null;
    let readCount = 0;
    if (isVisionConfigured()) {
      const result = await readFields(
        buf.toString("base64"),
        mediaType,
        "Live selling results screen",
        LIVE_OPS_SNAP_FIELDS
      );
      if (result.ok) {
        extracted = result.values;
        readCount = Object.keys(result.values).length;
      }
    }
    await db
      .from("contributor_logs")
      .update({
        evidence_photo_path: path,
        extracted_metrics: extracted,
        // status stays 'unverified' — never advance it here.
        updated_at: new Date().toISOString(),
      })
      .eq("id", logId);

    return NextResponse.json({
      ok: true,
      message:
        readCount > 0
          ? "Results submitted for review."
          : "Photo submitted — a moderator will review the numbers.",
      values: extracted ?? {},
    });
  }

  return bad("Unknown action.");
}
