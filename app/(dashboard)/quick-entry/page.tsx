import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resolveManualCatalogScope } from "@/lib/metrics/data";
import { QuickEntryGrid } from "@/components/quick-entry/QuickEntryGrid";

// Standalone mobile Quick-Entry — leadership (and every team member) records the
// hand-enterable (lane='manual') metric floor here. Its scope + catalog come from
// resolveManualCatalogScope (lib/metrics/data), the SAME resolver the Data
// Analytics Quick-Entry modal uses, so the two surfaces can never diverge.
export const dynamic = "force-dynamic";

export default async function QuickEntryPage() {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();

  const { canPickDepartment, ownDepartment, departments, catalog } =
    await resolveManualCatalogScope(supabase, profile);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Quick Entry"]} profile={profile}>
      <PageHeader
        title="Quick Entry"
        subtitle="Record today's hand-entered metrics. Type a number on each line and save — blanks are left as “—”."
      />

      <QuickEntryGrid
        canPickDepartment={canPickDepartment}
        departments={departments}
        ownDepartment={ownDepartment}
        catalog={catalog}
      />
    </AppShell>
  );
}
