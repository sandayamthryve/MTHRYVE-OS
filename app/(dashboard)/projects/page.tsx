import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui";
import { ProjectsLog } from "@/components/projects/ProjectsLog";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadProjectsBoard } from "@/lib/tony/panels";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

export const dynamic = "force-dynamic";

type ArchivedProject = {
  id: string;
  name: string;
  archived_at: string | null;
};

// Projects Log — the full-page board. Same RLS-scoped component as the /tony
// panel, given room to breathe: Working On · Next · Paused · Done, with inline
// add/edit and quick status moves. Org-scoped by RLS on every read/write.
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const archived = searchParams?.archived === "1";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const board = await loadProjectsBoard(supabase);

  const counts = board.projects.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});

  // The Archived view is a direct read of soft-archived projects (the board and
  // the Tony panel both hide these); it renders as a flat list with restore /
  // hard-delete actions since the client board only handles active projects.
  let archivedProjects: ArchivedProject[] = [];
  if (archived) {
    const { data } = await supabase
      .from("projects")
      .select("id, name, archived_at, description, status, due_date, brand_id, owner_id, department_id")
      .not("archived_at", "is", null)
      .order("updated_at", { ascending: false });
    archivedProjects = (data ?? []) as unknown as ArchivedProject[];
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "Projects"]} profile={profile}>
      <PageHeader
        title="Projects Log"
        subtitle={
          <>
            {counts.active ?? 0} working on · {counts.planned ?? 0} next · {counts.on_hold ?? 0}{" "}
            paused · {counts.completed ?? 0} done (30d)
          </>
        }
      />

      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-muted">
          Every project the org is working on, grouped by status. Move a card between columns to
          change its status, or add and edit inline. Active and paused projects are the same set Tony
          loads into every Ask&nbsp;Mthryve&nbsp;AI answer.
        </p>
        <ArchivedToggle basePath="/projects" archived={archived} />
      </div>

      {archived ? (
        archivedProjects.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
            No archived projects.
          </div>
        ) : (
          <div className="space-y-1.5">
            {archivedProjects.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2"
              >
                <span className="text-sm text-ink">{p.name}</span>
                <RowActions
                  {...rowActionProps("projects", p as unknown as Record<string, unknown>, profile)}
                />
              </div>
            ))}
          </div>
        )
      ) : (
        <ProjectsLog
          orgId={profile.org_id}
          userId={profile.id}
          projects={board.projects}
          brands={board.brands}
          users={board.users}
          departments={board.departments}
        />
      )}
    </AppShell>
  );
}
