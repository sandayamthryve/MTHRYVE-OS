import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  listCapabilities,
  listSkillOptions,
  listWorkflowOptions,
} from "@/lib/capabilities/data";
import { CapabilityRegistry } from "@/components/vesper/CapabilityRegistry";

// Vesper Core — the capability registry. The org's map of what the OS can
// actually do, across 16 intelligence domains and ~300 capabilities, each a
// status-colored chip (live / partial / planned / vendor). Reads run on the
// caller's RLS client (org-scoped); leadership can edit status + references; every
// live/partial capability can be turned into real, linked mission tasks.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };
const LEADERSHIP = ["ceo", "coo", "department_head"];

export default async function VesperCorePage() {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;
  const canEdit = LEADERSHIP.includes(profile.role);

  // All RLS-scoped. Capabilities drive the grid; skill/workflow options feed the
  // leadership edit pickers; users feed the mission-task assignee dropdown.
  const [capabilities, skillOptions, workflowOptions, usersRes] = await Promise.all([
    listCapabilities(db),
    listSkillOptions(db),
    listWorkflowOptions(db),
    db.from("users").select("id, full_name").order("full_name", { ascending: true }),
  ]);

  const users = ((usersRes.data ?? []) as { id: string; full_name: string | null }[])
    .filter((u) => u.full_name)
    .map((u) => ({ id: u.id, name: u.full_name as string }));

  return (
    <AppShell breadcrumb={["Mthryve OS", "Growth", "Vesper Core"]} profile={profile}>
      <PageHeader
        title="Vesper Core"
        subtitle="The capability registry — what Mthryve can actually do, across 16 intelligence domains. Each capability is scored by status; live and partial ones can be turned into real, linked tasks."
      />
      <CapabilityRegistry
        capabilities={capabilities}
        canEdit={canEdit}
        skillOptions={skillOptions}
        workflowOptions={workflowOptions}
        users={users}
      />
    </AppShell>
  );
}
