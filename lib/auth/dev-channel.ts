import type { SessionProfile } from "@/lib/auth/session";
import type { UserRole } from "@/types/database";
import { WORKSPACE_ROLES, type WorkspaceRole } from "./module-access";

// The devchannel is protected by the database-independent Basic Auth gate.
// When mock mode is enabled, use a fixed in-memory CEO identity so reviewers do
// not also need a Supabase account. This never creates or reads a database row.
export function isDevChannelAuthBypassEnabled(): boolean {
  return (
    process.env.DEV_CHANNEL_BYPASS_AUTH === "true" ||
    process.env.AGENT_MOCK_MODE === "true"
  );
}

export const DEV_CHANNEL_PROFILE: SessionProfile = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-000000000002",
  department_id: null,
  department_name: null,
  full_name: "Dev Reviewer",
  email: "dev@mthryve.local",
  role: "ceo",
  avatar_url: null,
  team_assignment: null,
  employment_status: "active",
  probation_end: null,
};

// Account role carried by each preview view. Preview roles are department
// scopes, not identities: they all share the one in-memory operator profile and
// create no account, membership, database role or department row.
//
// team_member is the floor, and the right answer for a scope that only needs to
// LOOK at its modules. HR is raised to department_head (2026-09-17, by request)
// so its rail can open the Department Cockpit, which calls
// requireRole(["ceo","coo","department_head"]).
//
// This is not a per-page grant. `department_head` is checked in ~325 places --
// contract and commerce-ops actions, archive config, assistant actions,
// notification producers, metrics -- so HR gains that authority everywhere,
// including writes. Raise a scope here only when that is what you mean.
const PREVIEW_ACCOUNT_ROLES: Partial<Record<WorkspaceRole, UserRole>> = {
  hr: "department_head",
};

// Team assignment carried by each preview view.
//
// A narrower instrument than PREVIEW_ACCOUNT_ROLES above, and the reason it
// exists. Some write gates ask "is this person on the warehouse team?" rather
// than "is this person leadership" -- isWarehouseWriter passes for ceo, coo,
// department_head, OR any profile whose team_assignment names warehouse. The
// Warehouse preview was team_member with no assignment, so it failed both
// halves and Product Master rendered read-only: no add, no bulk upload, no
// bulk edit, no per-row editing. A warehouse scope that cannot touch the
// product master is not showing what that role does.
//
// Assigning the team fixes that WITHOUT raising the account role, so Warehouse
// gains exactly the warehouse write surface and none of the ~325 places that
// check department_head. That is the whole point of doing it here instead of
// adding warehouse to the map above.
const PREVIEW_TEAM_ASSIGNMENTS: Partial<Record<WorkspaceRole, string>> = {
  // 2026-09-17, by request: makes the Warehouse view a warehouse writer.
  warehouse: "Warehouse & Fulfillment",
};

export function devChannelProfileForRole(role: WorkspaceRole): SessionProfile {
  const selected = WORKSPACE_ROLES.find((item) => item.id === role)!;
  return {
    ...DEV_CHANNEL_PROFILE,
    role: role === "operator" ? DEV_CHANNEL_PROFILE.role : (PREVIEW_ACCOUNT_ROLES[role] ?? "team_member"),
    team_assignment: PREVIEW_TEAM_ASSIGNMENTS[role] ?? DEV_CHANNEL_PROFILE.team_assignment,
    department_name: selected.department,
    preview_role: role,
  };
}
