// Vesper Studio access gate — who may upload replays, sign uploads and create
// clip jobs on the Vesper surface. One predicate, used by the page AND both API
// routes so the UI and the server never disagree.
//
// The rule (from the Phase 1 spec): Creative department members + leadership
// (department_head + ceo/coo). Leadership is a pure role check; a Creative
// member is a team_member whose users.department_id resolves to the "Creative"
// department (see migration 0001, which seeds it by that name). The department
// name is resolved once per request (RLS-scoped read); it is compared
// case-insensitively and by substring so "Creative" / "Creatives" both pass.

import type { UserRole } from "@/types/database";

// Roles that always have access regardless of department.
const LEADERSHIP_ROLES: UserRole[] = ["ceo", "coo", "department_head"];

// The seeded Creative department name (migration 0001). Matching is
// case-insensitive + substring so "Creative" and "Creatives" both qualify.
const CREATIVE_DEPARTMENT_MATCH = "creative";

// Minimal profile shape this gate needs.
export interface VesperAccessProfile {
  role: UserRole;
  department_id: string | null;
}

// A loosely-typed read client for the one departments lookup below. The generated
// Supabase types cover departments, but every Vesper helper already casts through
// a shim; this keeps the gate independent of that surface.
type DeptReadDb = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

// Fast, synchronous part of the gate: leadership always passes. Kept separate so
// callers can short-circuit before touching the database.
export function isVesperLeadership(profile: VesperAccessProfile): boolean {
  return LEADERSHIP_ROLES.includes(profile.role);
}

// The full gate. Returns true for leadership, or for a member of the Creative
// department. A user with no department (and not leadership) is denied — honest:
// we can't confirm Creative membership we don't have. Any lookup error → denied.
export async function hasVesperStudioAccess(
  supabase: unknown,
  profile: VesperAccessProfile
): Promise<boolean> {
  if (isVesperLeadership(profile)) return true;
  if (!profile.department_id) return false;

  const { data, error } = await (supabase as DeptReadDb)
    .from("departments")
    .select("name")
    .eq("id", profile.department_id)
    .maybeSingle();
  if (error) {
    console.error("[vesper] department lookup failed for access gate", error);
    return false;
  }
  const name = ((data as { name?: string } | null)?.name ?? "").trim().toLowerCase();
  return name.includes(CREATIVE_DEPARTMENT_MATCH);
}
