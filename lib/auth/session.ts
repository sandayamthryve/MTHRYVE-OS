import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/database";
import {
  devChannelProfileForRole,
  isDevChannelAuthBypassEnabled,
} from "@/lib/auth/dev-channel";
import { canAccessModulePath, workspaceRoleForProfile, type WorkspaceRole } from "./module-access";
import { DEV_SESSION_COOKIE, DEV_ROLE_COOKIE, PREVIEW_PATH_HEADER, PREVIEW_QUERY_HEADER, resolvePreviewRole, canAccessPreviewRequest } from "./preview-access";

// The authenticated user's Mthryve profile (public.users), joined with the
// Supabase auth identity. This is the single source of "who is this and what
// can they see" for server components — every dashboard reads from here.
export interface SessionProfile {
  // A server-resolved operator preview preference, never a database role.
  preview_role?: WorkspaceRole;
  id: string;
  org_id: string;
  department_id: string | null;
  // The user's department NAME (public.departments.name), resolved by joining
  // department_id. Null when the user has no department. This is what the
  // department-scoped nav gates and the requireDepartment guard match on — the
  // department_id uuid alone isn't human-meaningful at the call sites.
  department_name: string | null;
  full_name: string;
  email: string;
  role: UserRole;
  avatar_url: string | null;
  // Free-text team the user belongs to (e.g. "Business Development"). Drives the
  // Client Ownership Split: Business Development owns the client relationship, so
  // its members may write to the canonical client table alongside leadership.
  team_assignment: string | null;
  // Employment lifecycle. A new hire is created 'probationary' with a
  // probation_end date; leadership promotes them to 'active' once confirmed.
  // Both drive the probation access gate (see isProbationLapsed / requireProfile).
  employment_status: string | null;
  probation_end: string | null;
}

// Returns the current user's profile, or null if not signed in / no profile row.
// Null-profile-but-authenticated shouldn't happen in practice — the 0004
// handle_new_user trigger provisions a profile on signup — but we handle it
// defensively rather than assuming.
export async function getSessionProfile(): Promise<SessionProfile | null> {
  if (isDevChannelAuthBypassEnabled()) {
    const cookieStore = cookies();
    if (cookieStore.get(DEV_SESSION_COOKIE)?.value !== "active") return null;
    const role = resolvePreviewRole(cookieStore.get(DEV_ROLE_COOKIE)?.value);
    if (!role) return null;
    // Middleware overwrites these headers. Recheck here for server components,
    // actions and handlers; merely hiding links is not authorization.
    const requestHeaders = headers();
    const path = requestHeaders.get(PREVIEW_PATH_HEADER);
    if (!path || !canAccessPreviewRequest(role, path, requestHeaders.get(PREVIEW_QUERY_HEADER) ?? "")) return null;
    return devChannelProfileForRole(role);
  }

  const supabase = createServerSupabaseClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) {
    // Log the real reason instead of failing silently. A token-refresh error
    // here (or a getUser() that returns no user despite a session cookie) is
    // invisible in Vercel runtime logs unless we surface it. `AuthSessionMissingError`
    // is the benign "no one is signed in" case — still logged, but expected.
    if (userError) {
      console.error("[getSessionProfile] auth.getUser() failed:", userError.message);
    }
    return null;
  }

  // Pin the departments embed to the explicit FK constraint
  // (`departments!users_department_id_fkey`). There are TWO relationships
  // between public.users and public.departments — users.department_id →
  // departments.id (the department the user BELONGS to) AND
  // departments.lead_user_id → users.id (departments the user LEADS). A bare
  // `departments(name)` embed leaves PostgREST to pick between them; naming the
  // FK guarantees we always resolve the many-to-one department the user belongs
  // to, and removes the latent PGRST201 ("more than one relationship was found")
  // ambiguity a future schema-cache reload could otherwise surface. This is
  // defensive: the profile query itself has been verified to resolve correctly
  // under RLS for real users — see the error logging below, which is what makes
  // any actual failure (auth, embed, or RLS) visible instead of a silent null.
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select(
      "id, org_id, department_id, full_name, email, role, avatar_url, team_assignment, employment_status, probation_end, departments!users_department_id_fkey(name)"
    )
    .eq("id", user.id)
    .single();

  if (profileError) {
    // Surface the ACTUAL PostgREST error (code + message) so a future embed /
    // RLS / relationship regression is diagnosable from the runtime logs rather
    // than guessed at. `.single()` also errors (PGRST116) when zero rows match —
    // that's the genuine "authenticated but no profile row" case, still logged.
    console.error(
      `[getSessionProfile] profile query failed for user ${user.id}:`,
      `${profileError.code ?? "?"} ${profileError.message}`,
      profileError.details ?? ""
    );
    return null;
  }

  if (!profile) return null;

  // Explicit cast avoids the @supabase/ssr select-inference `never` quirk
  // (employment_status / probation_end aren't in the generated Row type yet).
  // The embedded `departments` is the joined many-to-one row (or null); flatten
  // its name onto department_name so callers never touch the nested shape.
  const row = profile as unknown as Omit<SessionProfile, "department_name"> & {
    departments?: { name: string } | { name: string }[] | null;
  };
  const dept = Array.isArray(row.departments) ? row.departments[0] : row.departments;
  return { ...row, department_name: dept?.name ?? null };
}

// --- Probation lifecycle & access gate --------------------------------------
// A new hire is 'probationary' with a probation_end date. Once probation_end has
// PASSED they are treated as SUSPENDED by the session guard (requireProfile)
// until leadership promotes them to 'active' (People → Make Permanent).
// employment_status is free text on the live users table; the two values this
// feature cares about are compared case-insensitively.
export function isProbationary(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "probationary";
}

// Whole days from today until probation_end, inclusive of the end day:
//   > 0  still on probation, N days left
//   = 0  final day of probation
//   < 0  probation has lapsed (suspended until promoted)
// null when not applicable — not probationary, or no end date recorded.
// probation_end is a DATE column, so we compare date-to-date (UTC) and ignore
// clock time entirely.
export function probationDaysLeft(
  profile: { employment_status: string | null; probation_end: string | null },
  now: Date = new Date()
): number | null {
  if (!isProbationary(profile.employment_status) || !profile.probation_end) return null;
  const end = Date.parse(`${profile.probation_end}T00:00:00Z`);
  if (Number.isNaN(end)) return null;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((end - today) / 86_400_000);
}

// The gate's core predicate: a probationary user whose probation_end has PASSED
// is suspended. A probationary user WITHOUT an end date is never blocked — we
// can't suspend someone against a date that was never set.
export function isProbationLapsed(
  profile: { employment_status: string | null; probation_end: string | null },
  now: Date = new Date()
): boolean {
  const left = probationDaysLeft(profile, now);
  return left !== null && left < 0;
}

// Use in any page that must have a signed-in user. Redirects to /login otherwise.
export async function requireProfile(): Promise<SessionProfile> {
  const profile = await getSessionProfile();
  if (!profile) redirect("/login");
  // Server-side access gate: a probationary hire whose probation window has
  // closed is treated as suspended — bounced to an honest "access pending
  // confirmation" screen — until leadership makes them permanent. Active and
  // leadership users are never probationary, so they pass straight through.
  if (isProbationLapsed(profile)) redirect("/access-pending");
  return profile;
}

// Use in role-gated pages (e.g. the CEO dashboard). Sends users who lack the
// role back to their own home route rather than showing a forbidden page —
// the router at / already knows where each role belongs.
export async function requireRole(allowed: UserRole[]): Promise<SessionProfile> {
  const profile = await requireProfile();
  if (!allowed.includes(profile.role)) redirect("/");
  return profile;
}

// A PDF module grant permits entering the module. Existing action-specific
// requireRole checks remain separate (and preview users are not leadership).
export async function requireModule(path: string): Promise<SessionProfile> {
  const profile = await requireProfile();
  if (!canAccessModulePath(workspaceRoleForProfile(profile), path)) redirect("/access-denied");
  return profile;
}

// --- Department-scoped access ------------------------------------------------
// Leadership sees the whole OS regardless of department. The enterprise
// user_role enum tops out at ceo/coo (there is no separate is_super_admin role
// or column in this schema), so leadership === ceo | coo. Centralised here so
// every department gate agrees on who bypasses it.
export function isLeadership(role: UserRole): boolean {
  return role === "ceo" || role === "coo";
}

export interface DepartmentAccessOptions {
  // Leadership (ceo/coo) bypasses the department check. Defaults to true — the
  // matrix always lets leadership through; pass false only for a gate that must
  // exclude even leadership (none today).
  allowLeadership?: boolean;
  // Explicit user-id allowlist, checked in addition to the department match —
  // for people granted a tool outside their own department (e.g. Arrianne on
  // Affiliate Reach).
  allowUserIds?: readonly string[];
}

// Pure predicate mirroring the nav gate: an item/page is allowed when the user
// is leadership (unless opted out), OR their id is explicitly allowlisted, OR
// their department name is one of the allowed departments. A user with no
// department only ever matches via leadership or the id allowlist — the safe
// default (never "more"). Department names compare case-insensitively/trimmed
// so a stray casing in the data can't silently deny.
export function hasDepartmentAccess(
  profile: Pick<SessionProfile, "id" | "role" | "department_name">,
  departments: readonly string[],
  { allowLeadership = true, allowUserIds = [] }: DepartmentAccessOptions = {}
): boolean {
  if (allowLeadership && isLeadership(profile.role)) return true;
  if (allowUserIds.includes(profile.id)) return true;
  const dept = (profile.department_name ?? "").trim().toLowerCase();
  if (!dept) return false;
  return departments.some((d) => d.trim().toLowerCase() === dept);
}

// Page-level department gate — mirrors requireProfile / requireRole. A user who
// resolves no access is bounced to "/" (their own home), exactly as requireRole
// does, rather than shown a forbidden page. This is the REAL enforcement; the
// matching nav gate is only cosmetic. RLS still scopes rows underneath — this
// adds a route gate, it does not replace row security.
export async function requireDepartment(
  departments: readonly string[],
  opts: DepartmentAccessOptions = {}
): Promise<SessionProfile> {
  const profile = await requireProfile();
  if (!hasDepartmentAccess(profile, departments, opts)) redirect("/");
  return profile;
}

// Who may create/edit client relationship records (the canonical `brands`
// table). Mirrors the brands RLS policy from migration 0025 exactly: leadership
// (ceo/coo/department_head) OR any member whose team_assignment is Business
// Development. Business Development OWNS the client relationship — this is the
// single gate the owner module (/clients) uses so the UI and RLS never disagree.
export function isClientOwner(profile: {
  role: UserRole;
  team_assignment?: string | null;
}): boolean {
  if (profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head") {
    return true;
  }
  return (profile.team_assignment ?? "").trim().toLowerCase() === "business development";
}

// Who may write the Warehouse module's domain tables (products, stock_levels,
// stock_movements). Mirrors the RLS write predicate from migration 0026 exactly:
// leadership (ceo/coo/department_head) OR any member whose team_assignment names
// Warehouse. This is the single gate the Warehouse UI uses so the controls it
// shows and what RLS will actually accept never disagree.
export function isWarehouseWriter(profile: {
  role: UserRole;
  team_assignment?: string | null;
}): boolean {
  if (profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head") {
    return true;
  }
  return (profile.team_assignment ?? "").toLowerCase().includes("warehouse");
}

// The canonical home route for a given profile. Under the Unified Home every role
// lands on "/", which itself branches by role (ceo/coo → Mission Control,
// department_head → dept home, team_member → member home — see app/(dashboard)/
// page.tsx). Kept as a function so the /home dispatcher, the auth callbacks and any
// post-action redirects all agree on the one landing. The legacy per-role cockpits
// (/home/my-day · /home/dept · /home/operations · /home/view-as) remain reachable
// from the Home nav group; they're just no longer the post-login destination.
export function homeRouteFor(_profile: SessionProfile): string {
  return "/";
}
