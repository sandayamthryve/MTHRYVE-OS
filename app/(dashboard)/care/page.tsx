import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { CareChat } from "@/components/care/CareChat";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { canManageProbation } from "@/lib/people/probation";
import { AgentMockModeNotice } from "@/components/agents/AgentMockModeNotice";

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

export default async function CarePage() {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Care metrics strip: pulse count + probation review-due (HR aggregates).
  let pulseCount: number | null = null;
  let reviewDue = 0;
  let canSeePulse = false;
  try {
    const isLeadership = profile.role === "ceo" || profile.role === "coo";
    const isHr = await canManageProbation(db, profile as any);
    canSeePulse = isLeadership || isHr;
    if (canSeePulse) {
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const [{ data: pulses }, { data: users }] = await Promise.all([
        (supabase as any).from("wellbeing_pulses").select("id").gte("pulse_date", since),
        (supabase as any).from("users").select("employment_status, probation_end").eq("org_id", profile.org_id),
      ]);
      pulseCount = (pulses ?? []).length;
      const { probationDaysLeft, isProbationary } = await import("@/lib/auth/session");
      reviewDue = ((users ?? []) as any[]).filter((u: any) => {
        const left = probationDaysLeft(u, new Date());
        return isProbationary(u.employment_status) && left !== null && left <= 14;
      }).length;
    }
  } catch {
    // pulse table may not exist until migration applied — honest empty.
  }

  const canFile = profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";

  return (
    <AppShell breadcrumb={["Mthryve OS", "People", "Care"]} profile={profile}>
      <PageHeader
        title="Care — wellbeing & people care"
        subtitle="Care listens, checks your own pulse, and proposes confidential check-ins for HR to approve — never contacts anyone directly. All team aggregates are anonymized."
      />
      <AgentMockModeNotice />

      {canSeePulse && pulseCount !== null && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <SectionCard title="Pulse 14d (anonymized)" className="p-4">
            <p className="text-2xl font-semibold text-ink">{pulseCount}</p>
            <p className="text-xs text-ink-muted">wellbeing pulses logged</p>
          </SectionCard>
          <SectionCard title="Probation review due" className="p-4">
            <p className="text-2xl font-semibold text-ink">{reviewDue}</p>
            <p className="text-xs text-ink-muted">within 14 days — needs care check</p>
          </SectionCard>
          <SectionCard title="Your wellbeing" className="p-4">
            <p className="text-sm text-ink-muted">Log today&apos;s mood 1-5 in the chat — e.g. &quot;log my mood 4 — good focus&quot;. One per day, you can update.</p>
          </SectionCard>
        </div>
      )}

      <SectionCard title="Talk to Care" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">
          Try: &quot;How am I doing?&quot; · &quot;Team pulse?&quot; · &quot;Check on probation care for Alex&quot; · &quot;HR policy on leave?&quot; · &quot;Propose a check-in for Alex because late 3× this week&quot;
        </p>
        <CareChat canFile={canFile} />
      </SectionCard>

      <SectionCard title="How Care handles privacy" className="mb-6">
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-muted">
          <li>Your mood 1-5 and note are your data — HR sees only anonymized team averages, never your raw note unless you share it.</li>
          <li>Team pulse = average + count over 14 days, not a list of who felt what.</li>
          <li>Probation care context is HR/leadership only and cites probation_end + attendance patterns — still proposes, HR approves.</li>
          <li>All check-ins are <span className="text-ink">pending approval</span> — Care files, a human approves in Approvals, the executor logs the care_check_ins row and the notification. Nothing is sent externally.</li>
        </ul>
      </SectionCard>
    </AppShell>
  );
}
