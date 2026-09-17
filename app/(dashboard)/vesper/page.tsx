import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, Card } from "@/components/ui";
import { requireDepartment } from "@/lib/auth/session";
import { VESPER_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { VesperConsole } from "@/components/vesper/VesperConsole";
import { VESPER_PLAY_TYPES, VESPER_PLAYS, VESPER_SOURCE_MODULE } from "@/lib/vesper/plays";
import { statusTone, STATUS_LABEL, type ActionStatus } from "@/lib/actions/types";

// Vesper — the Operator agent cockpit. The chat console runs the Vesper persona
// (a second assistant on the same tool-loop); the plays reference shows the six
// internal executors; and the recent-plays list shows the Tony→Vesper handoffs
// filed on the action_requests spine (source_module = 'tony_plan') with their
// live status. Everything Vesper does is internal and approval-gated.
//
// action_requests isn't in the generated Database types (provisioned out-of-
// band), so it's read through the app's cast shim.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };
const LEADERSHIP = ["ceo", "coo", "department_head"];

interface PlayRow {
  id: string;
  title: string;
  status: ActionStatus;
  source_ref: { play?: string } | null;
  created_at: string;
  executed_at: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function VesperPage() {
  // Vesper Reach — department-scoped to Creative + Live Operations; leadership
  // bypasses. Filing plays stays leadership-only (canFile below); RLS scopes rows.
  const profile = await requireDepartment(VESPER_DEPTS);
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;
  const canFile = LEADERSHIP.includes(profile.role);

  const { data } = await db
    .from("action_requests")
    .select("id, title, status, source_ref, created_at, executed_at")
    .eq("source_module", VESPER_SOURCE_MODULE)
    .order("created_at", { ascending: false })
    .limit(12);
  const recent = (data ?? []) as PlayRow[];

  return (
    <AppShell breadcrumb={["Mthryve OS", "Growth", "Vesper"]} profile={profile}>
      <PageHeader
        title="Vesper — Operator"
        subtitle="The agent that runs the Growth Pod machine. Tony plans; Vesper executes — every play routes through the approval spine and logs to the audit trail."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <VesperConsole canFile={canFile} />
        </div>

        <div className="space-y-6">
          <SectionCard title="Plays">
            <ul className="space-y-2">
              {VESPER_PLAY_TYPES.map((t) => {
                const spec = VESPER_PLAYS[t];
                return (
                  <li key={t} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink">{spec.label}</span>
                      <Badge tone={spec.writes ? "amber" : "teal"}>{spec.writes ? "writes" : "read-only"}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{spec.description}</p>
                    <p className="mt-1 font-mono text-[10px] text-ink-dim">via {spec.engine}</p>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        </div>
      </div>

      <div className="mt-6">
        <SectionCard
          title="Recent plays"
          action={
            <a href="/approvals" className="text-xs text-teal-300 underline hover:text-ink">
              Approval queue →
            </a>
          }
        >
          {recent.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No plays filed yet. Ask Vesper in the console to run one — it&apos;ll land here and in the
              approval queue as pending.
            </p>
          ) : (
            <ul className="divide-y divide-charcoal-700/60">
              {recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{r.title}</p>
                    <p className="font-mono text-[10px] text-ink-dim">
                      {r.source_ref?.play ?? "—"} · filed {fmtDate(r.created_at)}
                      {r.executed_at ? ` · ran ${fmtDate(r.executed_at)}` : ""}
                    </p>
                  </div>
                  <Badge tone={statusTone(r.status)}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <Card className="mt-6 border-charcoal-700/40">
        <p className="text-xs text-ink-dim">
          Vesper is internal and safe by construction: no outbound messages or posts, no ad spend, no
          money movement, no new integrations. Consequential execution only happens after a human
          approves in the queue.
        </p>
      </Card>
    </AppShell>
  );
}
