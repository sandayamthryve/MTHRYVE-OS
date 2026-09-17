import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadOperations } from "@/lib/home/cockpit";
import { OperationsView } from "@/components/home/cockpit-views";
import { QuickEntryLauncher } from "@/components/quick-entry/QuickEntryLauncher";
import { ActionCard } from "@/components/approvals/ActionCard";
import { isEmailConfigured } from "@/lib/outreach/email";
import { loadMissionControl } from "@/lib/ceo/mission-control";
import type { ActionAuditRow } from "@/lib/actions/types";

// Operations — the COO home: cross-department health · all pending approvals ·
// live bottlenecks. Org-wide (COO/CEO see everything); the /home dispatcher sends
// the COO here on login.
export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const profile = await requireRole(["ceo", "coo"]);
  const supabase = createServerSupabaseClient();
  const [data, mc] = await Promise.all([
    loadOperations(supabase, { orgId: profile.org_id }),
    loadMissionControl(supabase, profile.org_id),
  ]);
  const emailConfigured = isEmailConfigured();

  const auditByRequest = new Map<string, ActionAuditRow[]>();
  for (const a of data.approvalsAudit) {
    if (!a.action_request_id) continue;
    const list = auditByRequest.get(a.action_request_id) ?? [];
    list.push(a);
    auditByRequest.set(a.action_request_id, list);
  }

  const approvalsSlot = (
    <SectionCard title="All approvals" className="mb-6">
      {data.approvals.length === 0 ? (
        <p className="text-sm text-ink-muted">No pending approvals across the org.</p>
      ) : (
        <div className="space-y-4">
          {data.approvals.map((r) => (
            <ActionCard
              key={r.id}
              request={r}
              role={profile.role}
              userName={data.userNames}
              audit={auditByRequest.get(r.id) ?? []}
              emailConfigured={emailConfigured}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "Operations"]} profile={profile}>
      <PageHeader
        title="Operations"
        subtitle="Cross-department health, every pending approval, and where live operations are bottlenecked."
      />

      <OperationsView
        data={data}
        deptHealth={mc.deptHealth}
        approvalsSlot={approvalsSlot}
        captureSlot={
          <div className="mb-6">
            <QuickEntryLauncher />
          </div>
        }
      />
    </AppShell>
  );
}
