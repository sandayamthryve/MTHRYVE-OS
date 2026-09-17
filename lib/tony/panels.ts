import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { ProjectCard } from "@/components/projects/ProjectsLog";
import type { MemoryItem } from "@/components/tony/TonyMemoryPanel";
import { doneSinceIso } from "@/lib/projects/display";

// Server-side loaders shared by the /tony panels and the /projects board. Both
// read through the request-scoped @supabase/ssr client, so Postgres RLS scopes
// every row to the caller's org automatically — nothing here filters by org
// itself. The @supabase/ssr client resolves .select() to `never`, so results
// are cast at the call site (the same shim the rest of the app uses).

type Supa = ReturnType<typeof createServerSupabaseClient>;

type Option = { id: string; name: string };

export type ProjectsBoardData = {
  projects: ProjectCard[];
  brands: Option[];
  users: Option[];
  departments: Option[];
};

// Everything the Projects Log board needs: the on-board projects (active,
// planned, on_hold, plus completed within the last 30 days) and the option
// lists for the add/edit forms. Archived projects are intentionally excluded.
export async function loadProjectsBoard(supabase: Supa): Promise<ProjectsBoardData> {
  const since = doneSinceIso();
  const [openRes, doneRes, brandsRes, usersRes, deptsRes] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, description, status, due_date, brand_id, owner_id, department_id, archived_at")
      .in("status", ["active", "planned", "on_hold"])
      .is("archived_at", null)
      .order("due_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("projects")
      .select("id, name, description, status, due_date, brand_id, owner_id, department_id, archived_at")
      .eq("status", "completed")
      .is("archived_at", null)
      .gte("updated_at", since)
      .order("updated_at", { ascending: false }),
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
    supabase.from("departments").select("id, name").order("name"),
  ]);

  const open = (openRes.data ?? []) as unknown as ProjectCard[];
  const done = (doneRes.data ?? []) as unknown as ProjectCard[];
  const brands = (brandsRes.data ?? []) as unknown as Option[];
  const users = ((usersRes.data ?? []) as unknown as { id: string; full_name: string }[]).map(
    (u) => ({ id: u.id, name: u.full_name })
  );
  const departments = (deptsRes.data ?? []) as unknown as Option[];

  return { projects: [...open, ...done], brands, users, departments };
}

// Tony Memory for display: pinned first, then most-recent, capped so the panel
// stays scannable. RLS scopes to the org.
export async function loadMemories(supabase: Supa, limit = 60): Promise<MemoryItem[]> {
  const { data } = await supabase
    .from("tony_memory")
    .select("id, category, content, pinned, source, updated_at")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as MemoryItem[];
}
