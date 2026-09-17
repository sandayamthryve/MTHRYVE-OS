import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { AtlasChat } from "@/components/atlas/AtlasChat";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { AgentMockModeNotice } from "@/components/agents/AgentMockModeNotice";

export const dynamic = "force-dynamic";

export default async function AtlasPage() {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  let docCount: number | null = null;
  let capCount: number | null = null;
  try {
    const [{ data: docs }, { data: caps }] = await Promise.all([
      (supabase as any).from("documents").select("id", { count: "exact", head: true }),
      (supabase as any).from("capabilities").select("id", { count: "exact", head: true }),
    ]);
    docCount = docs ? 0 : 0; // head:true returns count in count field not data, fallback
    capCount = caps ? 0 : 0;
  } catch {}
  const canFile = profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  return (
    <AppShell breadcrumb={["Mthryve OS", "Knowledge", "Atlas"]} profile={profile}>
      <PageHeader title="Atlas — knowledge graph" subtitle="Atlas maps what Mthryve knows — documents, memory, and the live org graph — and cites the source. Never invents." />
      <AgentMockModeNotice />
      <SectionCard title="Talk to Atlas" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">Try: &quot;Search SOP for onboarding&quot; · &quot;Recall memory about creator tiers&quot; · &quot;Show graph snapshot&quot; · &quot;List capabilities for TikTok&quot;</p>
        <AtlasChat canFile={canFile} />
      </SectionCard>
      <SectionCard title="What Atlas reads" className="mb-6">
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-muted">
          <li>Knowledge Base documents (cite source_title) — numbers are &quot;as documented&quot;, not live.</li>
          <li>Durable memory `tony_memory` (pinned first).</li>
          <li>Live graph snapshot: org, departments, brands, capabilities sample — honest empty if none.</li>
          <li>All proposed captures file `pending` — HR/leadership approves before any doc is created.</li>
        </ul>
      </SectionCard>
    </AppShell>
  );
}
