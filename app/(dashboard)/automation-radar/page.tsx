import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, HelpHint } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { AutomationRadar } from "@/components/automation-radar/AutomationRadar";
import { RunDetectionButton } from "@/components/automation-radar/RunDetectionButton";

// Automation Radar — the org-wide leadership roll-up. ONE detector mines all
// departments' work for repetition; this page renders the SAME <AutomationRadar>
// component with no department filter, so leadership sees every team's patterns
// ranked by org-wide time cost. The identical component, filtered per department,
// is embedded inside each department tab. Detection is read-only; proposing an
// automation files a pending action_request — nothing auto-executes.

export const dynamic = "force-dynamic";

const LEADERSHIP = ["ceo", "coo", "department_head"];

export default async function AutomationRadarPage() {
  const profile = await requireProfile();
  const canRunDetection = LEADERSHIP.includes(profile.role);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Workflow", "Automation Radar"]} profile={profile}>
      <PageHeader
        title={<>Automation Radar <HelpHint id="work.automationRadar" /></>}
        subtitle="One engine mines every department's real work for repetition and proposes automations — approval-gated. Ranked by estimated monthly time cost. Nothing runs until a leader approves; execution wiring is Phase 2."
        action={canRunDetection ? <RunDetectionButton /> : undefined}
      />
      <AutomationRadar department={null} />
    </AppShell>
  );
}
