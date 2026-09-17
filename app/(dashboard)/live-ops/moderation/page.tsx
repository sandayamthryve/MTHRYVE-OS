import { requireModule } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { canModerate, signEvidenceUrls } from "@/lib/contributors/access";
import { approveWorkData, rejectWorkData } from "./actions";

// Moderator work-data gate. A live host snaps their live-results screen on the
// public /host page; it lands here as an 'unverified' contributor_log carrying an
// evidence photo and the auto-read viewers/gmv/ctor. Joycel + leadership review
// it. "Approve work-data" promotes it to a live_sessions row (via a new server
// action); "Reject" closes it out. The queue is RLS-scoped to the moderator's
// assigned brands (leadership sees all) — no brand filter is repeated here.

export const dynamic = "force-dynamic";

type LogRow = {
  id: string;
  contributor_id: string;
  brand_id: string | null;
  log_date: string;
  evidence_photo_path: string | null;
  extracted_metrics: Record<string, unknown> | null;
  status: string;
  work_reviewed_at: string | null;
  created_at: string;
};

const METRIC_LABEL: Record<string, string> = { viewers: "Viewers", gmv: "GMV", ctor: "CTOR" };

function MetricChips({ metrics }: { metrics: Record<string, unknown> | null }) {
  const entries = Object.entries(metrics ?? {}).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return <span className="text-ink-dim">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded-full border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 font-mono text-[10px] text-teal-300"
        >
          <span className="uppercase tracking-wider">{METRIC_LABEL[k] ?? k}</span>
          <span className="text-ink">{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

export default async function ModerationQueuePage() {
  const profile = await requireModule("/live-ops/moderation");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };

  if (!profile.preview_role && !(await canModerate(db, profile.id, profile.role))) redirect("/");

  // RLS scopes these to the moderator's brands (or everything for leadership).
  const { data: logRows } = await db
    .from("contributor_logs")
    .select(
      "id, contributor_id, brand_id, log_date, evidence_photo_path, extracted_metrics, status, work_reviewed_at, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(200);
  const logs = (logRows ?? []) as LogRow[];

  // The work-data queue = unverified logs that actually carry a snap (photo or
  // read numbers). Attendance-only logs are handled by the attendance gate.
  const hasWork = (l: LogRow) =>
    !!l.evidence_photo_path || (l.extracted_metrics && Object.keys(l.extracted_metrics).length > 0);
  const pending = logs.filter((l) => l.status === "unverified" && hasWork(l));
  const recent = logs.filter((l) => l.status === "work_approved" || l.status === "rejected").slice(0, 15);

  // Names for the contributors + brands referenced (org-readable via RLS).
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

  const signed = await signEvidenceUrls(pending.map((l) => l.evidence_photo_path));

  const contribName = (id: string) => contribById.get(id)?.name ?? "Contributor";
  const brandName = (id: string | null) => (id ? brandById.get(id) ?? "—" : "—");

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Ops", "Moderation Queue"]} profile={profile}>
      <PageHeader
        title="Moderation Queue"
        subtitle="Review host live-results snaps. Approving promotes the numbers to a live session; rejecting closes the entry. Scoped to your assigned brands."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Pending review" value={pending.length} valueClassName={pending.length ? "text-amber-300" : "text-ink"} />
        <StatTile label="Approved" value={logs.filter((l) => l.status === "work_approved").length} />
        <StatTile label="Rejected" value={logs.filter((l) => l.status === "rejected").length} />
        <StatTile label="Total snaps" value={logs.filter(hasWork).length} />
      </div>

      <SectionCard
        title="Awaiting work-data review"
        action={<Badge tone={pending.length ? "amber" : "muted"}>{pending.length} pending</Badge>}
        className="mb-6"
      >
        {pending.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">Nothing awaiting review. New host snaps land here.</p>
        ) : (
          <TableShell columns={["Host", "Brand", "Date", "Snapped numbers", "Evidence", "Decision"]}>
            {pending.map((l) => {
              const url = l.evidence_photo_path ? signed.get(l.evidence_photo_path) : undefined;
              const kind = contribById.get(l.contributor_id)?.kind;
              return (
                <tr key={l.id} className={rowClass}>
                  <td className="p-3 text-ink">
                    {contribName(l.contributor_id)}
                    {kind === "intern" && <Badge tone="violet" className="ml-2">Intern</Badge>}
                  </td>
                  <td className="p-3 text-ink-muted">{brandName(l.brand_id)}</td>
                  <td className="p-3 font-mono text-xs text-ink-muted">{l.log_date}</td>
                  <td className="p-3">
                    <MetricChips metrics={l.extracted_metrics} />
                  </td>
                  <td className="p-3">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block"
                        title="Open evidence photo"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt="Live results evidence"
                          className="h-14 w-14 rounded-md object-cover ring-1 ring-charcoal-700 transition hover:ring-teal-500"
                        />
                      </a>
                    ) : (
                      <span className="text-ink-dim">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1.5">
                      <form action={approveWorkData}>
                        <input type="hidden" name="id" value={l.id} />
                        <button
                          type="submit"
                          className="rounded-md bg-green-500/90 px-2.5 py-1 text-xs font-medium text-charcoal-950 hover:bg-green-400"
                        >
                          Approve work-data
                        </button>
                      </form>
                      <form action={rejectWorkData}>
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
          <TableShell columns={["Host", "Brand", "Date", "Numbers", "Outcome"]}>
            {recent.map((l) => (
              <tr key={l.id} className={rowClass}>
                <td className="p-3 text-ink">{contribName(l.contributor_id)}</td>
                <td className="p-3 text-ink-muted">{brandName(l.brand_id)}</td>
                <td className="p-3 font-mono text-xs text-ink-muted">{l.log_date}</td>
                <td className="p-3">
                  <MetricChips metrics={l.extracted_metrics} />
                </td>
                <td className="p-3">
                  {l.status === "work_approved" ? (
                    <Badge tone="teal">Approved · promoted</Badge>
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
