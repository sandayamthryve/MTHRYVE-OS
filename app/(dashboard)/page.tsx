import { AppShell } from "@/components/layout/AppShell";
import { DevBentoDashboard } from "@/components/home/DevBentoDashboard";
import { requireProfile } from "@/lib/auth/session";

// The root route is intentionally role-independent at the presentation layer.
// Every authenticated role lands on the same Operator-style Bento dashboard.
// RBAC still applies at the module/action/data layers; this page must never
// fall back to the old role workspace/module-card selector.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const profile = await requireProfile();

  return (
    <AppShell breadcrumb={["Mthryve OS", "Home"]} profile={profile}>
      <DevBentoDashboard profile={profile} />
    </AppShell>
  );
}
