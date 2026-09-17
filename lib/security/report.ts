// lib/security/report.ts — client → server bridge for the auth security events.
//
// The login and set-password screens run in the browser against Supabase auth,
// so they report the event to /api/auth/audit, which records it on the shared
// action_audit trail with a SERVER-VERIFIED identity (the client is never
// trusted for who did it — see app/api/auth/audit/route.ts).
//
// Best-effort by design: a failed report must never block sign-in or the
// password flow, so every call swallows its own errors.

export type ClientAuthEvent = "login" | "failed_login" | "password_change";

export async function reportAuthEvent(event: ClientAuthEvent, email?: string): Promise<void> {
  try {
    await fetch("/api/auth/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Same-origin: the auth cookie rides along so the server can verify identity.
      credentials: "same-origin",
      body: JSON.stringify({ event, email }),
      keepalive: true,
    });
  } catch {
    // Auditing is best-effort; never surface a failure to the user.
  }
}

// The MFA lifecycle events, recorded on the privileged audit_log trail via
// /api/auth/mfa/audit. Same contract as reportAuthEvent: the server verifies the
// session and stamps identity; the client is trusted only for the (non-secret)
// event + factor context. Best-effort — a failed report never blocks the flow.
export type ClientMfaEvent = "mfa_enrolled" | "mfa_challenge_passed" | "mfa_unenrolled";

export async function reportMfaEvent(
  event: ClientMfaEvent,
  meta?: { factorId?: string; friendlyName?: string }
): Promise<void> {
  try {
    await fetch("/api/auth/mfa/audit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ event, ...meta }),
      keepalive: true,
    });
  } catch {
    // Auditing is best-effort; never surface a failure to the user.
  }
}
