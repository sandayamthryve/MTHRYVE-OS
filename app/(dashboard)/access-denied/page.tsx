import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { requireProfile } from "@/lib/auth/session";
import { workspaceHome, workspaceRoleForProfile } from "@/lib/auth/module-access";

export const dynamic = "force-dynamic";

export default async function AccessDeniedPage() {
  const profile = await requireProfile();
  const role = workspaceRoleForProfile(profile);
  return (
    <AppShell profile={profile} breadcrumb={["Mthryve OS", "Access restricted"]}>
      <section className="mx-auto max-w-lg rounded-2xl border border-[#20313c] bg-[#0d141b] p-8">
        <h1 className="text-xl font-extrabold">This module isn’t available to your role.</h1>
        <p className="mt-3 text-sm text-ink-muted">Open your workspace to see the modules you can use.</p>
        <Link href={role ? workspaceHome(role) : "/workspace"} className="mt-6 inline-block rounded-lg bg-teal-400 px-4 py-2 text-sm font-bold text-[#04120c]">Back to workspace</Link>
      </section>
    </AppShell>
  );
}
