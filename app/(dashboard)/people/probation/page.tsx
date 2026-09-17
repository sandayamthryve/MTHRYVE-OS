import { requireModule } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, StatTile, TableShell, rowClass } from "@/components/ui";
import { ProbationDecision } from "@/components/people/ProbationDecision";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  canManageProbation,
  listProbationQueue,
  PROBATION_REVIEW_WINDOW_DAYS,
} from "@/lib/people/probation";

// Probation queue — the HR-facing lifecycle for new hires. Restricted to
// leadership (CEO / COO) and the HR & Admin department head (the page gate below
// mirrors canManageProbation exactly, which the decision actions re-check). It
// lists every probationary hire WITH a probation_end, soonest first, flags those
// inside the review window, and offers the three decisions — Regularize, Extend,
// Release — each of which transitions employment_status and appends a
// probation_reviews ledger row via the server actions.

export const dynamic = "force-dynamic";

type Dept = { id: string; name: string };

// Days-left → badge label + tone. Negative = lapsed (already suspended by the
// session gate); 0 = last day; ≤ window = review due; otherwise on track.
function statusBadge(daysLeft: number | null, reviewDue: boolean) {
  if (daysLeft !== null && daysLeft < 0) {
    return { tone: "red" as const, label: `Lapsed · ${Math.abs(daysLeft)}d ago` };
  }
  if (daysLeft === 0) return { tone: "red" as const, label: "Review due · last day" };
  if (reviewDue) return { tone: "amber" as const, label: `Review due · ${daysLeft}d left` };
  return { tone: "teal" as const, label: daysLeft === null ? "On probation" : `${daysLeft}d left` };
}

export default async function ProbationQueuePage() {
  const profile = await requireModule("/people/probation");
  const supabase = createServerSupabaseClient();

  // The precise gate: leadership or the HR & Admin head. A non-HR department
  // head is bounced back to the roster they can see.
  const allowed = await canManageProbation(
    supabase as unknown as { from: (t: string) => any },
    profile
  );
  if (!profile.preview_role && !allowed) redirect("/people");

  const [queue, deptRes, usersRes] = await Promise.all([
    listProbationQueue(supabase as unknown as { from: (t: string) => any }, profile.org_id),
    supabase.from("departments").select("id, name").order("name"),
    supabase.from("users").select("id, full_name"),
  ]);

  const departments = (deptRes.data ?? []) as unknown as Dept[];
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const nameById = new Map(
    ((usersRes.data ?? []) as unknown as Array<{ id: string; full_name: string }>).map((u) => [
      u.id,
      u.full_name,
    ])
  );

  const dueCount = queue.filter((r) => r.reviewDue).length;
  const lapsedCount = queue.filter((r) => r.daysLeft !== null && r.daysLeft < 0).length;

  const columns = ["Name", "Department", "Supervisor", "Probation ends", "Status", "Decision"];

  return (
    <AppShell breadcrumb={["Mthryve OS", "People", "Probation"]} profile={profile}>
      <PageHeader
        title="Probation queue"
        subtitle={`Every new hire still on probation, soonest end first. A hire is flagged “Review due” once their probation ends within ${PROBATION_REVIEW_WINDOW_DAYS} days. Record a decision — regularize, extend or release — and the OS transitions their status, logs it to the review ledger and notifies their supervisor.`}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label="On probation" value={queue.length} hint="With an end date" />
          <StatTile label="Review due" value={dueCount} hint={`≤ ${PROBATION_REVIEW_WINDOW_DAYS} days`} />
          <StatTile label="Lapsed" value={lapsedCount} hint="Past end · suspended" />
        </div>
        <Link
          href="/people"
          className="shrink-0 rounded-md bg-charcoal-800 px-3 py-2 text-sm text-ink-muted hover:bg-charcoal-700"
        >
          ← All people
        </Link>
      </div>

      <TableShell columns={columns}>
        {queue.length === 0 && (
          <tr>
            <td colSpan={columns.length} className="p-4 text-ink-muted">
              No one is on probation right now.
            </td>
          </tr>
        )}
        {queue.map((p) => {
          const badge = statusBadge(p.daysLeft, p.reviewDue);
          return (
            <tr key={p.id} className={rowClass}>
              <td className="p-3">
                <div className="text-ink">{p.full_name}</div>
                <div className="text-xs text-ink-muted">{p.email}</div>
              </td>
              <td className="p-3 text-ink-muted">
                {p.department_id ? deptName.get(p.department_id) ?? "—" : "—"}
              </td>
              <td className="p-3 text-ink-muted">
                {p.supervisor_id ? nameById.get(p.supervisor_id) ?? "—" : "—"}
              </td>
              <td className="p-3 font-mono text-ink-muted">{p.probation_end}</td>
              <td className="p-3">
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </td>
              <td className="p-3">
                <ProbationDecision
                  person={{ id: p.id, full_name: p.full_name, probation_end: p.probation_end }}
                />
              </td>
            </tr>
          );
        })}
      </TableShell>
    </AppShell>
  );
}
