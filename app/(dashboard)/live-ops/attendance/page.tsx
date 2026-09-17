import { requireModule } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { canModerate, signEvidenceUrls } from "@/lib/contributors/access";
import { approveAttendance, rejectAttendance } from "./actions";

// Contributor Attendance gate. A host clocks in with a selfie on the public /host
// page; it lands here as a contributor_log with clock_in_at + selfie_path and
// attendance_status 'pending'. Joycel + leadership approve or reject each one.
// RLS scopes the queue to the reviewer's assigned brands (leadership sees all).

export const dynamic = "force-dynamic";

const MANILA = "Asia/Manila";

type LogRow = {
  id: string;
  contributor_id: string;
  brand_id: string | null;
  log_date: string;
  clock_in_at: string | null;
  selfie_path: string | null;
  task_note: string | null;
  attendance_status: string;
  created_at: string;
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MANILA,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(t));
}

export default async function ContributorAttendancePage() {
  const profile = await requireModule("/live-ops/attendance");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };

  if (!profile.preview_role && !(await canModerate(db, profile.id, profile.role))) redirect("/");

  const { data: logRows } = await db
    .from("contributor_logs")
    .select(
      "id, contributor_id, brand_id, log_date, clock_in_at, selfie_path, task_note, attendance_status, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(200);
  const logs = (logRows ?? []) as LogRow[];

  // The attendance queue = logs that actually clocked in and await a decision.
  const clockedIn = (l: LogRow) => !!l.clock_in_at || !!l.selfie_path;
  const pending = logs.filter((l) => clockedIn(l) && l.attendance_status === "pending");
  const recent = logs
    .filter((l) => l.attendance_status === "approved" || l.attendance_status === "rejected")
    .slice(0, 15);

  const contribIds = Array.from(new Set(logs.map((l) => l.contributor_id)));
  const brandIds = Array.from(new Set(logs.map((l) => l.brand_id).filter((b): b is string => !!b)));
  const [{ data: contribRows }, { data: brandRows }] = await Promise.all([
    contribIds.length
      ? db.from("contributors").select("id, name, kind").in("id", contribIds)
      : Promise.resolve({ data: [] }),
    brandIds.length ? db.from("brands").select("id, name").in("id", brandIds) : Promise.resolve({ data: [] }),
  ]);
  const contribById = new Map(
    ((contribRows ?? []) as { id: string; name: string; kind: string }[]).map((c) => [c.id, c])
  );
  const brandById = new Map(((brandRows ?? []) as { id: string; name: string }[]).map((b) => [b.id, b.name]));

  const signed = await signEvidenceUrls(pending.map((l) => l.selfie_path));

  const contribName = (id: string) => contribById.get(id)?.name ?? "Contributor";
  const brandName = (id: string | null) => (id ? brandById.get(id) ?? "—" : "—");

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Ops", "Host Attendance"]} profile={profile}>
      <PageHeader
        title="Host Attendance"
        subtitle="Review each host's selfie clock-in and approve or reject their attendance for the day. Scoped to your assigned brands."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Pending" value={pending.length} valueClassName={pending.length ? "text-amber-300" : "text-ink"} />
        <StatTile label="Approved" value={logs.filter((l) => l.attendance_status === "approved").length} />
        <StatTile label="Rejected" value={logs.filter((l) => l.attendance_status === "rejected").length} />
        <StatTile label="Clock-ins" value={logs.filter(clockedIn).length} />
      </div>

      <SectionCard
        title="Awaiting attendance review"
        action={<Badge tone={pending.length ? "amber" : "muted"}>{pending.length} pending</Badge>}
        className="mb-6"
      >
        {pending.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">No clock-ins awaiting review.</p>
        ) : (
          <TableShell columns={["Selfie", "Host", "Brand", "Date", "Clock-in", "Task note", "Decision"]}>
            {pending.map((l) => {
              const url = l.selfie_path ? signed.get(l.selfie_path) : undefined;
              const kind = contribById.get(l.contributor_id)?.kind;
              return (
                <tr key={l.id} className={rowClass}>
                  <td className="p-3">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer" title="Open selfie">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt="Clock-in selfie"
                          className="h-14 w-14 rounded-md object-cover ring-1 ring-charcoal-700 transition hover:ring-teal-500"
                        />
                      </a>
                    ) : (
                      <span className="text-ink-dim">—</span>
                    )}
                  </td>
                  <td className="p-3 text-ink">
                    {contribName(l.contributor_id)}
                    {kind === "intern" && <Badge tone="violet" className="ml-2">Intern</Badge>}
                  </td>
                  <td className="p-3 text-ink-muted">{brandName(l.brand_id)}</td>
                  <td className="p-3 font-mono text-xs text-ink-muted">{l.log_date}</td>
                  <td className="p-3 font-mono text-ink-muted">{fmtTime(l.clock_in_at)}</td>
                  <td className="p-3 max-w-[16rem] text-xs text-ink-muted">
                    {l.task_note ? <span className="line-clamp-2">{l.task_note}</span> : <span className="text-ink-dim">—</span>}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1.5">
                      <form action={approveAttendance}>
                        <input type="hidden" name="id" value={l.id} />
                        <button
                          type="submit"
                          className="rounded-md bg-green-500/90 px-2.5 py-1 text-xs font-medium text-charcoal-950 hover:bg-green-400"
                        >
                          Approve
                        </button>
                      </form>
                      <form action={rejectAttendance}>
                        <input type="hidden" name="id" value={l.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-ink-muted hover:bg-charcoal-800 hover:text-ink"
                        >
                          Reject
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </SectionCard>

      {recent.length > 0 && (
        <SectionCard title="Recently reviewed">
          <TableShell columns={["Host", "Brand", "Date", "Clock-in", "Outcome"]}>
            {recent.map((l) => (
              <tr key={l.id} className={rowClass}>
                <td className="p-3 text-ink">{contribName(l.contributor_id)}</td>
                <td className="p-3 text-ink-muted">{brandName(l.brand_id)}</td>
                <td className="p-3 font-mono text-xs text-ink-muted">{l.log_date}</td>
                <td className="p-3 font-mono text-ink-muted">{fmtTime(l.clock_in_at)}</td>
                <td className="p-3">
                  {l.attendance_status === "approved" ? (
                    <Badge tone="teal">Approved</Badge>
                  ) : (
                    <Badge tone="red">Rejected</Badge>
                  )}
                </td>
              </tr>
            ))}
          </TableShell>
        </SectionCard>
      )}
    </AppShell>
  );
}
