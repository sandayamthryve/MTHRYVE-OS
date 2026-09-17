import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { HeraldChat } from "@/components/herald/HeraldChat";
import { requireProfile } from "@/lib/auth/session";
import { AgentMockModeNotice } from "@/components/agents/AgentMockModeNotice";

export const dynamic = "force-dynamic";

export default async function HeraldPage() {
  const profile = await requireProfile();
  const canFile = profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  return (
    <AppShell breadcrumb={["Mthryve OS", "Partners", "Herald"]} profile={profile}>
      <PageHeader title="Herald — outreach" subtitle="Herald drafts follow-ups to leads and creators — proposes, HR/leadership approves before anyone is contacted. Never sends directly." />
      <AgentMockModeNotice />
      <SectionCard title="Talk to Herald" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">Try: &quot;List outreach queue&quot; · &quot;Get outreach target Alex&quot; · &quot;Draft message for Alex&quot; · &quot;Propose send to Alex via email: Hello...&quot;</p>
        <HeraldChat canFile={canFile} />
      </SectionCard>
      <SectionCard title="How Herald handles sends" className="mb-6">
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-muted">
          <li>Drafts are deterministic — same lead/creator context → same draft.</li>
          <li>Sends file <span className="text-ink">pending</span> — leadership approves in Approvals; executor logs `outreach_activities` and stamps next touch (email only if configured, else copy-paste).</li>
          <li>All reads are RLS org-scoped.</li>
        </ul>
      </SectionCard>
    </AppShell>
  );
}
