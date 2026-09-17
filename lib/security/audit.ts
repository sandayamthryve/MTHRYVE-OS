// lib/security/audit.ts — the security-events layer over the shared action_audit
// trail (PASTE 3.2, Part B/C).
//
// action_audit already records the action spine (created / approved / executed).
// Here we add the SECURITY events — auth (login / failed login / password
// change), data exports, and policy changes — as ordinary rows on the SAME
// table. No schema change is needed: `event` is free text and the id/actor
// columns are nullable, so a new event type is just a new string.
//
// Every writer is best-effort (writeActionAudit swallows failures): recording
// the trail must never break the action it describes.

import { writeActionAudit } from "@/lib/actions/audit";

// The action_audit table isn't in the generated Database types, so callers pass
// either an RLS user client or the service-role client through this cast shim,
// exactly as the rest of the audit module does.
type Shim = { from: (t: string) => any };

// The security-relevant event types the leadership "Security events" view reads.
// Keep this list in sync with the filter in app/(dashboard)/security/page.tsx.
export const SECURITY_EVENTS = [
  "login",
  "failed_login",
  "password_change",
  "data_export",
  "policy_change",
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

// Resolve the acting user's org + role from an authenticated server client, so a
// security row is stamped with who did it. Returns null when unauthenticated.
export async function resolveAuditActor(
  supabase: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> }; from: (t: string) => any }
): Promise<{ org_id: string; actor_id: string; actor_role: string } | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("users")
    .select("org_id, role")
    .eq("id", user.id)
    .single();
  const org_id = (profile as { org_id?: string } | null)?.org_id;
  if (!org_id) return null;
  const actor_role = (profile as { role?: string } | null)?.role ?? "team_member";
  return { org_id, actor_id: user.id, actor_role };
}

// Record a data export against the caller's org. Reads the session from the
// passed server client; a no-op if unauthenticated. `detail` carries what was
// exported (module, format, filters) — never the exported rows themselves.
export async function auditDataExport(
  supabase: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> }; from: (t: string) => any },
  detail: Record<string, unknown>
): Promise<void> {
  const actor = await resolveAuditActor(supabase);
  if (!actor) return;
  await writeActionAudit(supabase as unknown as Shim, {
    org_id: actor.org_id,
    action_request_id: null,
    event: "data_export",
    actor_id: actor.actor_id,
    actor_role: actor.actor_role,
    detail,
  });
}
