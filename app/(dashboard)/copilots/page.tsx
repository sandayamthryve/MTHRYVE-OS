import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { HEALTH_COLOR, HEALTH_LABEL } from "@/lib/metrics/health";
import type { HealthDot } from "@/lib/metrics/types";
import { readCopilots, readCopilotStatus } from "@/lib/copilot/members";

// The Copilot Fleet hub — the picker. Each seeded copilot (a council_members row
// made conversational) renders as a card: name, title, domain, and a live
// grounding light aggregated from its compartments via the Cognition Loop's own
// READ half. Click through to a persistent, grounded chat with that copilot.
//
// Org-read for v1 (like the Council); the thread itself is self-only (RLS on
// ai_conversations). A copilot with no compartments wired shows "persona only" —
// it can still chat, just without live numbers.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

function StatusLight({ dot, mapped }: { dot: HealthDot; mapped: boolean }) {
  const color = mapped && dot ? HEALTH_COLOR[dot] : "bg-ink-dim";
  const label = !mapped ? "Persona only" : dot ? HEALTH_LABEL[dot] : "No data yet";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-full ${color} ${mapped && dot ? "shadow-glow" : ""}`} />
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</span>
    </span>
  );
}

export default async function CopilotsPage() {
  const profile = await requireProfile();
  const db = createServerSupabaseClient() as unknown as Shim;

  const copilots = await readCopilots(db);
  const statuses = await Promise.all(copilots.map((m) => readCopilotStatus(db, m)));
  const statusByKey = new Map(statuses.map((s) => [s.key, s]));

  return (
    <AppShell breadcrumb={["Mthryve OS", "AI Platform", "Copilots"]} profile={profile}>
      <PageHeader
        title="Copilot Fleet"
        subtitle={
          <>
            Each copilot is a domain expert you can talk to — grounded in its own compartment&apos;s
            live metrics, aware of your project docs, and honest about gaps. It can propose an action,
            but it never executes: anything real is routed for your approval.
          </>
        }
      />

      {copilots.length === 0 ? (
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
          No copilots are provisioned yet.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {copilots.map((m) => {
            const s = statusByKey.get(m.key);
            const mapped = s?.mapped ?? false;
            return (
              <li key={m.key}>
                <Link
                  href={`/copilots/${m.key}`}
                  className="flex h-full flex-col rounded-lg border border-charcoal-700 bg-charcoal-900 p-4 transition-colors hover:border-teal-500/50 hover:bg-charcoal-800"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{m.name}</p>
                      <p className="text-xs text-ink-muted">{m.title}</p>
                    </div>
                    <StatusLight dot={s?.dot ?? null} mapped={mapped} />
                  </div>

                  <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                    {m.domain}
                  </p>

                  <p className="mt-1 text-[11px] text-ink-muted">
                    {mapped
                      ? `${s?.grounded ?? 0}/${s?.total ?? 0} metrics grounded`
                      : "No compartments wired — persona-only chat."}
                  </p>

                  <span className="mt-3 flex flex-1 items-end text-xs font-medium text-teal-400">
                    Open chat →
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
  );
}
