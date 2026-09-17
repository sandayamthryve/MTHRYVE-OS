import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { ProspectorChat } from "@/components/prospector/ProspectorChat";
import { requireProfile } from "@/lib/auth/session";
import { AgentMockModeNotice } from "@/components/agents/AgentMockModeNotice";

export const dynamic = "force-dynamic";

export default async function ProspectorPage() {
  const profile = await requireProfile();
  const canFile = profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  return (
    <AppShell breadcrumb={["Mthryve OS", "Partners", "Prospector"]} profile={profile}>
      <PageHeader title="Prospector — opportunities" subtitle="Prospector scores candidates HOT/WARM/COLD via the opportunity_engine and proposes qualification tasks — BizDev approves, never contacts directly." />
      <AgentMockModeNotice />
      <SectionCard title="Talk to Prospector" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">Try: &quot;List prospect queue&quot; · &quot;Find prospects: name, category, monthly_revenue ...&quot; · &quot;Get prospect context for Alex&quot; · &quot;Propose qualification for Alex as HOT because...&quot;</p>
        <ProspectorChat canFile={canFile} />
      </SectionCard>
      <SectionCard title="Webhook" className="mb-6">
        <p className="text-xs text-ink-muted">Configure <span className="text-ink">automation_registry key=opportunity_engine</span> webhook for real scoring; without it Prospector returns a stub HONEST ranking and tells you to configure.</p>
      </SectionCard>
    </AppShell>
  );
}
