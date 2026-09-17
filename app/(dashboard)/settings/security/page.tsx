import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { isMfaEnforcementEnabled, roleRequiresMfa } from "@/lib/auth/mfa";
import { MfaManager } from "@/components/security/MfaManager";

// Settings → Security. Where every user manages their own two-factor
// authentication (TOTP). The heavy lifting is the MfaManager client island,
// which talks straight to Supabase auth; this server wrapper just resolves the
// profile and reads the (server-only) enforcement flag so the copy is honest
// about whether MFA is enforced yet.
//
// Runtime-rendered so MFA_ENFORCEMENT_ENABLED is read fresh per request — the
// switch takes effect without a redeploy (matches the /settings TikTok page).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export default async function SecuritySettingsPage() {
  const profile = await requireProfile();

  const enforcementEnabled = isMfaEnforcementEnabled();
  const roleRequires = roleRequiresMfa(profile.role);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Settings", "Security"]} profile={profile}>
      <PageHeader
        title="Security"
        subtitle="Protect your account with a second factor. Two-factor uses a code from an authenticator app on your phone."
      />

      <SectionCard title="🔐 Two-factor authentication">
        <MfaManager enforcementEnabled={enforcementEnabled} roleRequiresMfa={roleRequires} />
      </SectionCard>

      <p className="mt-4 text-xs text-ink-muted">
        Lost your device? A leadership admin can reset your authenticator from the Supabase
        dashboard (Authentication → Users) so you can enroll a new one — see the break-glass steps
        in <span className="font-mono text-ink">docs/MFA.md</span>.
      </p>
    </AppShell>
  );
}
