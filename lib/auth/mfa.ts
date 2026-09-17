// lib/auth/mfa.ts — the ONE place the OS decides "does this request need to
// step up to MFA (aal2), and where do we send them if so?".
//
// Design goals, all non-negotiable (see docs/MFA.md):
//   1. ENFORCEMENT IS OFF BY DEFAULT. The gate does nothing at all until
//      MFA_ENFORCEMENT_ENABLED === "true" is set in the environment. This is the
//      switch leadership flips deliberately AFTER testing on a throwaway account —
//      until then, enrolling a factor never changes anyone's login.
//   2. NEVER DEAD-END A REQUIRED USER. A user whose role requires MFA but who has
//      no factor yet is routed to enrollment (grace), never to a wall.
//   3. FAIL OPEN on any error reading the assurance level. Availability wins over
//      a transient Supabase blip: RLS still protects the data, and locking the
//      whole org out over a network error is the worse failure.
//
// Supabase stores TOTP factors in the managed `auth.mfa_factors` table and
// exposes the assurance level through supabase.auth.mfa.* — no app migration is
// needed. The audit trail for enroll / challenge / unenroll is written through
// lib/audit/log.ts (audit_log, migration 20260720000000).

import type { UserRole } from "@/types/database";

// Roles for which MFA is MANDATORY once enforcement is on. Leadership carries the
// keys to the whole OS, so they must carry a second factor. team_member is
// OPTIONAL — they may enroll, and if they do they'll be challenged, but the gate
// never forces them to.
export const MFA_REQUIRED_ROLES: readonly UserRole[] = ["ceo", "coo", "department_head"];

export function roleRequiresMfa(role: UserRole | string | null | undefined): boolean {
  return MFA_REQUIRED_ROLES.includes((role ?? "") as UserRole);
}

// The master switch. Server-only env (never NEXT_PUBLIC_*), read fresh per
// request so flipping it in the Vercel dashboard takes effect without a rebuild.
// Anything other than the exact string "true" (case-insensitive) leaves
// enforcement OFF — the safe default.
export function isMfaEnforcementEnabled(): boolean {
  return (process.env.MFA_ENFORCEMENT_ENABLED ?? "").trim().toLowerCase() === "true";
}

// Where the gate sends users. The challenge page is a child of /login so it sits
// outside the dashboard shell (an aal1 user hasn't fully "arrived" yet); the
// enrollment surface is the Settings → Security page.
export const MFA_CHALLENGE_PATH = "/login/mfa";
export const MFA_ENROLL_PATH = "/settings/security";

export type AalLevel = "aal1" | "aal2" | null;

export interface MfaGateInput {
  // Assurance level of the CURRENT session (from the JWT `aal` claim).
  currentLevel: AalLevel;
  // The HIGHEST level this user COULD reach — "aal2" iff they have at least one
  // VERIFIED factor. Supabase computes this from verified factors only, so an
  // abandoned half-finished enrollment never trips the gate.
  nextLevel: AalLevel;
  // Does this user's role make MFA mandatory? Only consulted in the no-factor
  // branch, so callers may pass false when a factor is known to exist.
  roleRequiresMfa: boolean;
  // The path being requested, so we don't redirect the destination onto itself.
  pathname: string;
}

// The pure decision: given the assurance levels + role + path, return the path to
// redirect to, or null to allow the request through. Callers gate this behind
// isMfaEnforcementEnabled() — this function assumes enforcement is already ON.
//
// The logic, in order:
//   • Already at aal2 → fully stepped up, allow everything.
//   • Has a verified factor but still aal1 → must complete the challenge. The one
//     path we allow through is the challenge page itself.
//   • No factor + role requires MFA → grace: route to enrollment (never a wall),
//     allowing the enrollment page itself through.
//   • No factor + role does NOT require MFA (team_member) → optional, allow.
export function mfaGateRedirect(input: MfaGateInput): string | null {
  const steppedUp = input.currentLevel === "aal2";
  if (steppedUp) return null;

  const hasVerifiedFactor = input.nextLevel === "aal2";
  if (hasVerifiedFactor) {
    return input.pathname === MFA_CHALLENGE_PATH ? null : MFA_CHALLENGE_PATH;
  }

  if (input.roleRequiresMfa) {
    return input.pathname === MFA_ENROLL_PATH ? null : MFA_ENROLL_PATH;
  }

  return null;
}

// Minimal shape of the Supabase client the gate needs. Kept structural so both
// the middleware server client and the SSR server client satisfy it without a
// hard dependency on the SDK's exported types.
export interface MfaGateClient {
  auth: {
    mfa: {
      // Loosely typed so both the middleware and SSR Supabase clients satisfy it
      // structurally — the SDK's precise union isn't worth coupling to here.
      getAuthenticatorAssuranceLevel: () => Promise<{ data: any; error: any }>;
    };
  };
  from: (table: string) => any;
}

// The async wrapper the middleware calls. Reads the assurance level (and, only
// when it matters, the user's role), then defers to mfaGateRedirect. Returns the
// redirect path or null.
//
// FAIL-OPEN: if the assurance level can't be read we return null (allow). A
// transient error must never lock the org out — the whole point of "don't dead-
// end anyone" applies to infrastructure hiccups too.
export async function evaluateMfaGate(
  supabase: MfaGateClient,
  userId: string,
  pathname: string
): Promise<string | null> {
  let currentLevel: AalLevel = null;
  let nextLevel: AalLevel = null;
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return null; // fail open
    currentLevel = data.currentLevel;
    nextLevel = data.nextLevel;
  } catch {
    return null; // fail open
  }

  // Only the no-factor branch consults the role, so only fetch it then. When the
  // user already has a verified factor the redirect is the challenge regardless
  // of role, so we skip the extra query.
  let requires = false;
  if (nextLevel !== "aal2" && currentLevel !== "aal2") {
    try {
      const { data: profile } = await supabase
        .from("users")
        .select("role")
        .eq("id", userId)
        .single();
      requires = roleRequiresMfa((profile as { role?: string } | null)?.role ?? null);
    } catch {
      // Couldn't read the role → treat as not-required so we never bounce a user
      // to enrollment on a bad read. (A user who genuinely needs MFA will still
      // be caught on the next request once the read succeeds.)
      requires = false;
    }
  }

  return mfaGateRedirect({ currentLevel, nextLevel, roleRequiresMfa: requires, pathname });
}
