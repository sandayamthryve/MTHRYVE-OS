// lib/skills/registry.ts
// Layer 4 — the Skill Library, made DISCOVERABLE through the public.skill_registry
// table. A "skill" is a named unit of reasoning the product already knows how to
// run (e.g. the AI Brief); the registry is the catalogue Tony (the Executive
// Brain) will read to learn what he can invoke. This file is READ-ONLY discovery:
// it does not run any skill, it only surfaces the catalogue rows.
//
// Every read goes through the caller's @supabase/ssr client, so Postgres RLS
// scopes rows to the caller's org (skill_registry_select: org_id = current_org).
// RLS does not filter by role, so listSkills() additionally hides skills whose
// required_role sits above the caller — a team_member never sees a ceo-only skill.
// No new tables, no generation logic.
import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { Json, UserRole } from "@/types/database";

type Supabase = ReturnType<typeof createServerSupabaseClient>;

// The public-facing shape of a catalogue entry. Mirrors the registry columns Tony
// needs to decide what to invoke and with what inputs — never the internal id /
// org_id / created_by bookkeeping.
export type SkillMeta = {
  key: string;
  name: string;
  description: string | null;
  category: string;
  input_schema: Json;
  output_shape: string | null;
  backing: string | null;
  required_role: string;
  enabled: boolean;
};

const SKILL_COLUMNS =
  "key, name, description, category, input_schema, output_shape, backing, required_role, enabled";

// Role visibility ladder. A skill tagged required_role R is visible to any caller
// whose role sits at or above R. required_role is a free-text column, so an
// unrecognized value falls through to "hidden unless you're leadership-visible".
const ROLE_RANK: Record<UserRole, number> = {
  team_member: 0,
  department_head: 1,
  coo: 2,
  ceo: 3,
};

// The set of required_role values a given role is allowed to see — used to filter
// in the query rather than post-hoc, so hidden skills never leave Postgres.
function visibleRequiredRoles(role: UserRole): UserRole[] {
  const ceiling = ROLE_RANK[role];
  return (Object.keys(ROLE_RANK) as UserRole[]).filter((r) => ROLE_RANK[r] <= ceiling);
}

// Every ENABLED skill the caller's role may see, ordered for a stable catalogue.
// This is what GET /api/skills returns and what Tony will read to discover his
// available reasoning. RLS already org-scopes the rows; we add enabled + role.
export async function listSkills(supabase: Supabase, role: UserRole): Promise<SkillMeta[]> {
  const res = await supabase
    .from("skill_registry")
    .select(SKILL_COLUMNS)
    .eq("enabled", true)
    .in("required_role", visibleRequiredRoles(role))
    .order("category", { ascending: true })
    .order("name", { ascending: true });
  return ((res.data ?? []) as unknown as SkillMeta[]) ?? [];
}

// A single skill's metadata by key, or null if the row is absent / not visible to
// the caller under RLS. Used as the single source of truth for a skill's
// name/description at its point of use (e.g. the AI Brief surface). Not filtered
// by enabled — this is a metadata lookup, not an "is it runnable" check.
export async function getSkill(supabase: Supabase, key: string): Promise<SkillMeta | null> {
  const res = await supabase
    .from("skill_registry")
    .select(SKILL_COLUMNS)
    .eq("key", key)
    .limit(1);
  return ((res.data ?? [])[0] ?? null) as unknown as SkillMeta | null;
}

// Fallback used when the registry row is missing (fresh org, row disabled, or a
// read failure) so a skill surface still renders its own name/description.
export const AI_BRIEF_FALLBACK: Pick<SkillMeta, "name" | "description"> = {
  name: "AI Brief",
  description:
    "Grounded what-is-happening / why / what-to-do / plan brief for a brand, department, org, or finance scope.",
};
