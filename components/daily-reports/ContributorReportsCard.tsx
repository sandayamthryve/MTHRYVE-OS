import { SectionCard, Badge } from "@/components/ui";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Contributor / intern daily reports for a department. Hosts and interns have no
// OS login — they file through the public /host portal, which writes a
// daily_reports row (contributor_id + department_id) exactly like a staff member's
// report. This card surfaces those rows on the DEPARTMENT dashboard, labeled so a
// department head can tell contributor work from staff work at a glance.
//
// Reads through the caller's own RLS-scoped client: daily_reports' SELECT policy
// is org-scoped (org_id = current_org_id()) and never referenced user_id, so a
// department head / leadership sees contributor rows (user_id IS NULL) the same as
// any other. No service role here — this is an ordinary authorized read.

type Db = { from: (t: string) => any };

type ReportRow = {
  id: string;
  contributor_id: string;
  work_date: string;
  summary: string | null;
  outputs: string | null;
  blockers: string | null;
};

export async function ContributorReportsCard({ departmentId }: { departmentId: string }) {
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  const { data: reportRows } = await db
    .from("daily_reports")
    .select("id, contributor_id, work_date, summary, outputs, blockers")
    .eq("department_id", departmentId)
    .not("contributor_id", "is", null)
    .eq("status", "submitted")
    .is("archived_at", null)
    .order("work_date", { ascending: false })
    .limit(25);
  const reports = (reportRows ?? []) as ReportRow[];

  // Contributor names + kind (Host / Intern), and confirmed-task counts per report.
  const contributorIds = Array.from(new Set(reports.map((r) => r.contributor_id)));
  const reportIds = reports.map((r) => r.id);
  const [{ data: contribRows }, { data: tagRows }] = await Promise.all([
    contributorIds.length
      ? db.from("contributors").select("id, name, kind").in("id", contributorIds)
      : Promise.resolve({ data: [] }),
    reportIds.length
      ? db.from("daily_report_tasks").select("report_id, confirmed").in("report_id", reportIds)
      : Promise.resolve({ data: [] }),
  ]);
  const contributor = new Map(
    ((contribRows ?? []) as { id: string; name: string; kind: string }[]).map((c) => [c.id, c])
  );
  const confirmedCount = new Map<string, number>();
  for (const t of (tagRows ?? []) as { report_id: string; confirmed: boolean | null }[]) {
    if (t.confirmed) confirmedCount.set(t.report_id, (confirmedCount.get(t.report_id) ?? 0) + 1);
  }

  return (
    <SectionCard
      title="Contributor & intern reports"
      icon="🧑‍💻"
      action={<Badge tone="muted">{reports.length}</Badge>}
      className="mb-8"
    >
      {reports.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No contributor or intern reports yet. Hosts and interns assigned to this department file
          their daily work through their /host link — submitted reports appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {reports.map((r) => {
            const c = contributor.get(r.contributor_id);
            const kindLabel = c?.kind === "intern" ? "Intern" : "Host";
            const tasks = confirmedCount.get(r.id) ?? 0;
            return (
              <li
                key={r.id}
                className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{c?.name ?? "Contributor"}</span>
                  <Badge tone="violet">Contributor · {kindLabel}</Badge>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                    {r.work_date}
                  </span>
                  {tasks > 0 && (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-teal-300">
                      {tasks} task{tasks === 1 ? "" : "s"} confirmed
                    </span>
                  )}
                </div>
                {r.outputs && <p className="mt-1.5 text-sm text-ink-muted">{r.outputs}</p>}
                {r.summary && <p className="mt-1 text-xs text-ink-dim">{r.summary}</p>}
                {r.blockers && (
                  <p className="mt-1 text-xs text-amber-300/90">Blockers: {r.blockers}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
