// lib/contributors/report.ts — the token-authed contributor → department report.
//
// A contributor (host / intern) has no OS login. When they submit their day on the
// public /host/<token> portal, this helper writes their work into the SAME spine a
// staff member uses (daily_reports + daily_report_tasks), so it surfaces on their
// DEPARTMENT dashboard exactly like a staff report — labeled contributor/intern.
//
// GOVERNANCE — this is the unauthenticated write path, so it is the choke-point
// that keeps a contributor to THEIR OWN lane:
//   • Every write's org_id + department_id come from the token-resolved contributor
//     (never the client). A contributor can only ever write their own department's
//     report, for their own org.
//   • The report requires the contributor to HAVE a department (a lead must attach
//     one first) — with none, there is nowhere to report and the submit is refused.
//   • Only tasks that are actually assigned to THIS contributor (open, same org)
//     can be confirmed; any other id in the payload is dropped, never written.
//   • It writes with the service-role client BECAUSE the portal is unauthenticated
//     and daily_reports is RLS-locked to OS users — the token is the credential,
//     re-validated upstream, and this module is where that power stays scoped.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { manilaToday } from "@/lib/hr/time";
import { safeUrl } from "@/lib/security/sanitize";
import { fetchOpenAssignedTasks, type TokenContributor } from "./tokens";

type Db = { from: (t: string) => any };

export interface ContributorReportInput {
  summary: string | null;
  outputs: string | null;
  blockers: string | null;
  taskIds: string[];
  evidenceLinks: string[];
}

export interface ContributorReportResult {
  ok: boolean;
  error?: string;
  reportId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Write (or replace) today's daily_reports row for a contributor and tag the tasks
// it confirms. `contributor` is the token-resolved record — its org_id and
// department_id are the ONLY scope used for every write here.
export async function submitContributorReport(
  contributor: Pick<TokenContributor, "id" | "org_id" | "department_id">,
  input: ContributorReportInput
): Promise<ContributorReportResult> {
  // A contributor with no department has nowhere to report — a lead must attach one
  // first. This is also the guard that keeps department_id non-null on every write.
  if (!contributor.department_id) {
    return { ok: false, error: "Your department isn't set yet — ask your team lead." };
  }

  const summary = input.summary?.trim().slice(0, 4000) || null;
  const outputs = input.outputs?.trim().slice(0, 8000) || null;
  const blockers = input.blockers?.trim().slice(0, 4000) || null;

  // Only confirm tasks that are genuinely this contributor's own open assignments.
  // Anything else in the payload (spoofed or stale) is dropped, never written.
  const requested = new Set(
    input.taskIds.map((t) => t.trim()).filter((t) => UUID_RE.test(t))
  );
  const ownTasks = await fetchOpenAssignedTasks(contributor);
  const allowed = new Set(ownTasks.map((t) => t.id));
  const confirmIds = [...requested].filter((id) => allowed.has(id));

  // Substance guard: a report must record real work — outputs, a summary, or at
  // least one confirmed task. An empty submit can't confirm anything.
  if (!outputs && !summary && confirmIds.length === 0) {
    return { ok: false, error: "Add what you worked on, or confirm a task, before submitting." };
  }

  const db = createServiceRoleClient() as unknown as Db;
  const workDate = manilaToday();

  // ── 1. Upsert today's report (one per org + contributor + work_date) ──────────
  // Explicit select→update/insert (rather than PostgREST upsert on the partial
  // unique index) so the scoping is unmistakable and portable.
  const { data: existing } = await db
    .from("daily_reports")
    .select("id")
    .eq("org_id", contributor.org_id)
    .eq("contributor_id", contributor.id)
    .eq("work_date", workDate)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  const body = {
    summary,
    outputs,
    blockers,
    status: "submitted",
    submitted_at: nowIso,
    updated_at: nowIso,
  };

  let reportId: string | null = (existing as { id?: string } | null)?.id ?? null;
  if (reportId) {
    // Re-submitting replaces today's report. Never re-scope an existing row's
    // org/contributor/department — only its body advances.
    const { error } = await db.from("daily_reports").update(body).eq("id", reportId);
    if (error) return { ok: false, error: "Couldn't save your report — please try again." };
  } else {
    const { data: created, error } = await db
      .from("daily_reports")
      .insert({
        org_id: contributor.org_id,
        contributor_id: contributor.id,
        // user_id stays NULL — the XOR check marks this a contributor report.
        department_id: contributor.department_id,
        work_date: workDate,
        ...body,
      })
      .select("id")
      .single();
    if (error || !created) return { ok: false, error: "Couldn't save your report — please try again." };
    reportId = (created as { id: string }).id;
  }
  if (!reportId) return { ok: false, error: "Report saved, but its id could not be resolved." };

  // ── 2. Rewrite the task tags to exactly the confirmed selection ───────────────
  // Delete-then-insert so un-ticking a task withdraws its confirmation. org_id is
  // the contributor's own — the tags never reach another org's report.
  await db.from("daily_report_tasks").delete().eq("report_id", reportId);
  if (confirmIds.length > 0) {
    const tags = confirmIds.map((task_id) => ({
      org_id: contributor.org_id,
      report_id: reportId,
      task_id,
      confirmed: true,
    }));
    await db.from("daily_report_tasks").insert(tags);
  }

  // ── 3. Attach evidence links (Creative "links", any dept) ─────────────────────
  // One URL per line, validated to a safe http(s) scheme. Best-effort: a link
  // failure never loses the confirmed report. Rewritten to the current set each
  // submit so a removed link goes away.
  const links = Array.from(
    new Set(input.evidenceLinks.map((l) => safeUrl(l)).filter((l): l is string => !!l))
  ).slice(0, 20);
  await db
    .from("evidence_attachments")
    .delete()
    .eq("entity_type", "daily_report")
    .eq("entity_id", reportId);
  if (links.length > 0) {
    const rows = links.map((url) => ({
      org_id: contributor.org_id,
      entity_type: "daily_report",
      entity_id: reportId,
      url,
      kind: "link",
      source_url: url,
    }));
    await db.from("evidence_attachments").insert(rows);
  }

  return { ok: true, reportId };
}
