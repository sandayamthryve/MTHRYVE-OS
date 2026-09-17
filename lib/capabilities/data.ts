// lib/capabilities/data.ts — RLS-scoped reads of public.capabilities.
//
// Every read runs on the CALLER'S @supabase/ssr client, so Postgres RLS is the
// hard wall: capabilities_select scopes rows to the caller's org. capabilities
// isn't in the generated Database types (seeded out of band), so — like the rest
// of the OS's newer tables — it's reached through the app's minimal cast shim.
//
// Server-only: this imports the shim shape, not the client itself, so the caller
// passes in whatever RLS-scoped client it already holds (server page, server
// action, or a Tony tool's ctx.supabase).

import {
  isCapabilityStatus,
  type Capability,
  type CapabilityStatus,
} from "@/lib/capabilities/types";

type Shim = { from: (t: string) => any };

// Columns we surface — never the org_id / created_at bookkeeping the UI doesn't
// need. id is included so edits and mission-task links can address a row.
const CAPABILITY_COLUMNS =
  "id, domain_no, domain, name, status, required_skills, required_tools, required_knowledge, required_agents, required_workflows, required_permissions, kpis, outputs, notes";

// Coerce a jsonb column that should be a string[] into one, defensively: the seed
// stores arrays, but a null / malformed value must never crash the page.
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

function normalize(row: Record<string, unknown>): Capability {
  const status = isCapabilityStatus(row.status) ? row.status : "planned";
  return {
    id: String(row.id),
    domain_no: Number(row.domain_no ?? 0),
    domain: String(row.domain ?? ""),
    name: String(row.name ?? ""),
    status,
    required_skills: strArray(row.required_skills),
    required_tools: strArray(row.required_tools),
    required_knowledge: strArray(row.required_knowledge),
    required_agents: strArray(row.required_agents),
    required_workflows: strArray(row.required_workflows),
    required_permissions: strArray(row.required_permissions),
    kpis: strArray(row.kpis),
    outputs: strArray(row.outputs),
    notes: typeof row.notes === "string" && row.notes.trim() ? row.notes.trim() : null,
  };
}

// All capabilities the caller can see (RLS org-scoped), ordered by domain then
// name so the grouped view is stable. Returns [] on any read error rather than
// throwing — the page still renders (empty) instead of 500-ing.
export async function listCapabilities(db: Shim): Promise<Capability[]> {
  const { data, error } = await db
    .from("capabilities")
    .select(CAPABILITY_COLUMNS)
    .order("domain_no", { ascending: true })
    .order("name", { ascending: true });
  if (error) return [];
  return ((data ?? []) as Record<string, unknown>[]).map(normalize);
}

// One capability by id, or null if absent / not visible under RLS.
export async function getCapabilityById(db: Shim, id: string): Promise<Capability | null> {
  if (!id) return null;
  const { data } = await db.from("capabilities").select(CAPABILITY_COLUMNS).eq("id", id).maybeSingle();
  return data ? normalize(data as Record<string, unknown>) : null;
}

// Free-text search over name + domain, returning the best matches. Used by Tony's
// search_capabilities tool: it loads the org's capabilities (RLS-scoped) and
// ranks them so the answer can be honest about status. Kept in app code (not SQL
// ilike) so ranking — exact name, name-contains, domain-contains — is explicit
// and the whole small set (~300) is cheap to score in memory.
export interface RankedCapability extends Capability {
  score: number;
}

export async function searchCapabilities(
  db: Shim,
  query: string,
  limit = 8
): Promise<RankedCapability[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const all = await listCapabilities(db);

  const scored = all
    .map((c) => {
      const name = c.name.toLowerCase();
      const domain = c.domain.toLowerCase();
      const hay = `${name} ${domain} ${c.outputs.join(" ")} ${c.notes ?? ""}`.toLowerCase();
      let score = 0;
      if (name === q) score += 100;
      if (name.includes(q)) score += 40;
      if (domain.includes(q)) score += 15;
      for (const t of terms) {
        if (name.includes(t)) score += 8;
        else if (hay.includes(t)) score += 3;
      }
      // Nudge available capabilities up so "can we do X" surfaces what's real
      // first, without ever hiding a planned match (status is still reported).
      if (score > 0) {
        if (c.status === "live") score += 2;
        else if (c.status === "partial") score += 1;
      }
      return { ...c, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

// Update a capability's status and/or reference fields. Leadership-only WRITE:
// capabilities_write RLS restricts UPDATE to ceo/coo/department_head in the org,
// so a non-leadership caller's update is simply rejected — the guard here just
// gives a clean message. `patch` is a partial of the editable columns; the caller
// (the server action) validates/shapes it before calling.
export async function updateCapability(
  db: Shim,
  id: string,
  patch: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  if (!id) return { ok: false, error: "Missing capability id." };
  if (Object.keys(patch).length === 0) return { ok: true };
  const { error } = await db
    .from("capabilities")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// The picker sources for the leadership edit form: skill_registry keys → names,
// and automation_registry keys → names. Both RLS-scoped to the caller's org.
export interface RegistryOption {
  key: string;
  name: string | null;
}

export async function listSkillOptions(db: Shim): Promise<RegistryOption[]> {
  const { data } = await db
    .from("skill_registry")
    .select("key, name")
    .order("name", { ascending: true });
  return ((data ?? []) as RegistryOption[]).filter((r) => r.key);
}

export async function listWorkflowOptions(db: Shim): Promise<RegistryOption[]> {
  const { data } = await db
    .from("automation_registry")
    .select("key, name")
    .order("name", { ascending: true });
  return ((data ?? []) as RegistryOption[]).filter((r) => r.key);
}

export type { CapabilityStatus };
