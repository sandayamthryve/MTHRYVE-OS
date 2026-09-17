import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { OracleChat } from "@/components/oracle/OracleChat";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { AgentMockModeNotice } from "@/components/agents/AgentMockModeNotice";

export const dynamic = "force-dynamic";

export default async function OraclePage() {
  const profile = await requireProfile();
  const isLeadership = profile.role === "ceo" || profile.role === "coo";
  const supabase = createServerSupabaseClient();
  let cash: any = null;
  try {
    if (isLeadership) {
      const { data } = await (supabase as any).from("cash_positions").select("amount, as_of_date").order("as_of_date", { ascending: false }).limit(1).maybeSingle();
      cash = data;
    }
  } catch {}
  const canFile = isLeadership;
  return (
    <AppShell breadcrumb={["Mthryve OS", "Money", "Oracle"]} profile={profile}>
      <PageHeader title="Oracle — finance forecast" subtitle="Oracle reads live P&L, cash positions, and budgets — never invents, always cites period. Proposals are recommendation-only, never moves money." />
      <AgentMockModeNotice />
      {isLeadership && cash && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <SectionCard title="Cash anchor" className="p-4">
            <p className="text-2xl font-semibold text-ink">₱{cash.amount ? Number(cash.amount).toLocaleString() : "—"}</p>
            <p className="text-xs text-ink-muted">as of {cash.as_of_date ?? "—"}</p>
          </SectionCard>
          <SectionCard title="Forecast horizons" className="p-4">
            <p className="text-sm text-ink-muted">30 / 60 / 90 days — run &quot;Cashflow forecast&quot; in chat.</p>
          </SectionCard>
          <SectionCard title="Budgets" className="p-4">
            <p className="text-sm text-ink-muted">Ask &quot;Budget health&quot; for utilization %.</p>
          </SectionCard>
        </div>
      )}
      {!isLeadership && (
        <SectionCard title="Restricted" className="mb-4">
          <p className="text-sm text-ink-muted">Finance is leadership-only (ceo/coo). Other roles see no numbers.</p>
        </SectionCard>
      )}
      <SectionCard title="Talk to Oracle" className="mb-6">
        <p className="mb-3 text-xs text-ink-muted">Try: &quot;Show P&amp;L last 60 days&quot; · &quot;Cashflow forecast&quot; · &quot;Budget health&quot; · &quot;Propose: tighten opex 10%&quot;</p>
        <OracleChat canFile={canFile} />
      </SectionCard>
    </AppShell>
  );
}
