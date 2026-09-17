import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadDeptCockpit } from "@/lib/home/cockpit";
import { DeptCockpitView } from "@/components/home/cockpit-views";
import { QuickEntryLauncher } from "@/components/quick-entry/QuickEntryLauncher";
import { ActionCard } from "@/components/approvals/ActionCard";
import { isEmailConfigured } from "@/lib/outreach/email";
import type { ActionAuditRow } from "@/lib/actions/types";
import { DeskBoard } from "@/components/home/DeskBoard";
import { deskViews } from "@/lib/home/cockpit-desks";
import { buildSnapshot } from "@/lib/os/snapshot";

// Dept Cockpit — the nine-desk board over the viewer's own cockpit.
//
// The board reads the SAME OS snapshot Home and the client views read, so the
// three cannot disagree; below it sits the department_head's own desk — team
// health · the approvals queue (live Approve/Reject where RLS allows) ·
// department metrics · who has filed today's Daily Report vs. not.
//
// The board is added above that, not in place of it: the overview answers "how
// is the company doing", the cockpit answers "what do I do next", and losing the
// second to gain the first would be a bad trade.
export const dynamic = "force-dynamic";

export default async function DeptCockpitPage() {
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const supabase = createServerSupabaseClient();
  const data = await loadDeptCockpit(supabase, {
    orgId: profile.org_id,
    departmentId: profile.department_id,
  });
  const emailConfigured = isEmailConfigured();

  // The board must never cost the cockpit: a failed snapshot drops the overview
  // and leaves the working page intact.
  const desks = await (async () => {
    try {
      const snapshot = await buildSnapshot({ supabase, orgId: profile.org_id, role: profile.role });
      return deskViews(snapshot);
    } catch {
      return null;
    }
  })();

  // Group the audit trail by request so each card gets only its own events.
  const auditByRequest = new Map<string, ActionAuditRow[]>();
  for (const a of data.approvalsAudit) {
    if (!a.action_request_id) continue;
    const list = auditByRequest.get(a.action_request_id) ?? [];
    list.push(a);
    auditByRequest.set(a.action_request_id, list);
  }

  const approvalsSlot = (
    <SectionCard title="Approvals queue" className="mb-6">
      {data.approvals.length === 0 ? (
        <p className="text-sm text-ink-muted">No pending approvals for your team.</p>
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
    <AppShell
      breadcrumb={["Mthryve OS", "Dept Cockpit", data.department?.name ?? "Department"]}
      profile={profile}
    >
      <PageHeader
        title="Department Cockpits"
        subtitle="Every desk, read from one snapshot — then your own team below."
      />

      {desks && (
        <div className="mb-8">
          <DeskBoard desks={desks} leadership={profile.role === "ceo" || profile.role === "coo"} />
        </div>
      )}

      <PageHeader
        title={data.department ? `${data.department.name} — Cockpit` : "Dept Cockpit"}
        subtitle="Your team at a glance — health, approvals, metrics, and today's Daily Reports."
      />

      {!profile.department_id && (
        <p className="mb-6 rounded-md border border-gold-500/40 bg-gold-500/10 px-4 py-3 text-sm text-gold-200">
          Your account has no department set — team-scoped panels will be empty until leadership
          assigns one.
        </p>
      )}

      <DeptCockpitView
        data={data}
        approvalsSlot={approvalsSlot}
        captureSlot={
          <div className="mb-6">
            <QuickEntryLauncher defaultDepartment={data.metricsDepartment} />
          </div>
        }
      />
    </AppShell>
  );
}
