import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass, HelpHint } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { TokenLink } from "./TokenLink";
import {
  createContributor,
  assignBrand,
  assignDepartment,
  assignTaskToContributor,
  revokeContributor,
  reactivateContributor,
  assignModerator,
  removeModerator,
} from "./actions";

// Contributor management — the host/intern programme's control room. Leadership
// and department heads create contributors (each gets an unguessable token and a
// /host/<token> link), assign them to a brand, and revoke them. Leadership (ceo/
// coo) additionally manage moderator↔brand assignments, which scope who can
// review each brand's logs in the Moderation and Attendance queues.

export const dynamic = "force-dynamic";

type Contributor = {
  id: string;
  name: string;
  handle: string | null;
  brand_id: string | null;
  department_id: string | null;
  platform: string | null;
  kind: string;
  token: string;
  status: string;
  created_at: string;
};
type BrandOpt = { id: string; name: string };
type DeptOpt = { id: string; name: string };
type Person = { id: string; full_name: string; role: string };
type ModAssignment = { id: string; user_id: string; brand_id: string };
type OpenTask = { id: string; contributor_id: string };

const FIELD =
  "block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink placeholder:text-ink-dim";

export default async function ContributorsPage() {
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const isLeadership = profile.role === "ceo" || profile.role === "coo";
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as { from: (t: string) => any };

  const [
    { data: contribRows },
    { data: brandRows },
    { data: deptRows },
    { data: taskRows },
    { data: userRows },
    { data: assignRows },
  ] = await Promise.all([
    db.from("contributors").select("id, name, handle, brand_id, department_id, platform, kind, token, status, created_at").order("created_at", { ascending: false }),
    db.from("brands").select("id, name").order("name"),
    db.from("departments").select("id, name").order("name"),
    // Open tasks assigned to contributors — to show each contributor's live load.
    db
      .from("tasks")
      .select("id, contributor_id")
      .not("contributor_id", "is", null)
      .is("archived_at", null)
      .in("status", ["todo", "in_progress", "blocked"]),
    isLeadership
      ? db.from("users").select("id, full_name, role").order("full_name")
      : Promise.resolve({ data: [] }),
    isLeadership
      ? db.from("moderator_brand_assignments").select("id, user_id, brand_id")
      : Promise.resolve({ data: [] }),
  ]);

  const contributors = (contribRows ?? []) as Contributor[];
  const brands = (brandRows ?? []) as BrandOpt[];
  const departments = (deptRows ?? []) as DeptOpt[];
  const openTasks = (taskRows ?? []) as OpenTask[];
  const people = (userRows ?? []) as Person[];
  const assignments = (assignRows ?? []) as ModAssignment[];

  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const personName = new Map(people.map((p) => [p.id, p.full_name]));
  const openTaskCount = new Map<string, number>();
  for (const t of openTasks) {
    openTaskCount.set(t.contributor_id, (openTaskCount.get(t.contributor_id) ?? 0) + 1);
  }
  const activeContributors = contributors.filter((c) => c.status === "active");

  const activeCount = contributors.filter((c) => c.status === "active").length;
  const hostCount = contributors.filter((c) => c.kind === "host").length;
  const internCount = contributors.filter((c) => c.kind === "intern").length;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Ops", "Contributors"]} profile={profile}>
      <PageHeader
        title={<>Contributors <HelpHint id="people.contributors" /></>}
        subtitle="Create hosts and interns, hand them their private /host link, set a brand and department, assign tasks, and revoke access. Their department decides which dashboard their daily reports land on. No OS login — the token in the link is their credential."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Active" value={activeCount} />
        <StatTile label="Hosts" value={hostCount} />
        <StatTile label="Interns" value={internCount} />
        <StatTile label="Total" value={contributors.length} />
      </div>

      {/* Create */}
      <SectionCard title="Add a contributor" className="mb-6">
        <form action={createContributor} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-[11px] text-ink-muted">
            Name
            <input name="name" required placeholder="Full name" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Handle (optional)
            <input name="handle" placeholder="@tiktok" className={`mt-1 ${FIELD}`} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Kind
            <select name="kind" defaultValue="host" className={`mt-1 ${FIELD}`}>
              <option value="host">Host</option>
              <option value="intern">Intern</option>
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Brand
            <select name="brand_id" defaultValue="" className={`mt-1 ${FIELD}`}>
              <option value="">— Unassigned —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Department
            <select name="department_id" defaultValue="" className={`mt-1 ${FIELD}`}>
              <option value="">— Unassigned —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Platform (optional)
            <input name="platform" placeholder="tiktok_shop" className={`mt-1 ${FIELD}`} />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Create & generate link
            </button>
          </div>
        </form>
      </SectionCard>

      {/* Roster */}
      <SectionCard title="Roster" className="mb-6">
        {contributors.length === 0 ? (
          <p className="py-4 text-sm text-ink-muted">No contributors yet. Add one above.</p>
        ) : (
          <TableShell columns={["Contributor", "Kind", "Brand", "Department", "Host link", "Status", "Actions"]}>
            {contributors.map((c) => (
              <tr key={c.id} className={rowClass}>
                <td className="p-3 text-ink">
                  {c.name}
                  {c.handle && <span className="ml-2 font-mono text-[11px] text-ink-dim">{c.handle}</span>}
                  {(openTaskCount.get(c.id) ?? 0) > 0 && (
                    <span className="ml-2 inline-flex items-center rounded-full border border-teal-500/40 bg-teal-500/10 px-2 py-0.5 font-mono text-[10px] text-teal-300">
                      {openTaskCount.get(c.id)} open task{openTaskCount.get(c.id) === 1 ? "" : "s"}
                    </span>
                  )}
                </td>
                <td className="p-3">
                  <Badge tone={c.kind === "intern" ? "violet" : "teal"}>{c.kind === "intern" ? "Intern" : "Host"}</Badge>
                </td>
                <td className="p-3">
                  <form action={assignBrand} className="flex items-center gap-1.5">
                    <input type="hidden" name="id" value={c.id} />
                    <select
                      name="brand_id"
                      defaultValue={c.brand_id ?? ""}
                      className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                    >
                      <option value="">— Unassigned —</option>
                      {brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="rounded-md bg-charcoal-800 px-2 py-1 text-[10px] font-semibold text-teal-300 hover:bg-charcoal-700"
                    >
                      Save
                    </button>
                  </form>
                </td>
                <td className="p-3">
                  <form action={assignDepartment} className="flex items-center gap-1.5">
                    <input type="hidden" name="id" value={c.id} />
                    <select
                      name="department_id"
                      defaultValue={c.department_id ?? ""}
                      className="rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink"
                    >
                      <option value="">— Unassigned —</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="rounded-md bg-charcoal-800 px-2 py-1 text-[10px] font-semibold text-teal-300 hover:bg-charcoal-700"
                    >
                      Save
                    </button>
                  </form>
                </td>
                <td className="p-3">
                  {c.status === "active" ? (
                    <TokenLink token={c.token} />
                  ) : (
                    <span className="font-mono text-[11px] text-ink-dim">revoked</span>
                  )}
                </td>
                <td className="p-3">
                  {c.status === "active" ? (
                    <Badge tone="teal">Active</Badge>
                  ) : (
                    <Badge tone="muted">Revoked</Badge>
                  )}
                </td>
                <td className="p-3">
                  {c.status === "active" ? (
                    <form action={revokeContributor}>
                      <input type="hidden" name="id" value={c.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-red-300 hover:bg-charcoal-800"
                      >
                        Revoke
                      </button>
                    </form>
                  ) : (
                    <form action={reactivateContributor}>
                      <input type="hidden" name="id" value={c.id} />
                      <button
                        type="submit"
                        className="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
                      >
                        Reactivate
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>

      {/* Assign a task to a contributor — it appears on their /host portal (open,
          read-only) for them to confirm in today's log. */}
      <SectionCard title="Assign a task to a contributor" className="mb-6">
        {activeContributors.length === 0 ? (
          <p className="py-2 text-sm text-ink-muted">Add an active contributor first.</p>
        ) : (
          <form action={assignTaskToContributor} className="grid gap-3 sm:grid-cols-[1fr_1.5fr_auto_auto]">
            <label className="text-[11px] text-ink-muted">
              Contributor
              <select name="contributor_id" required defaultValue="" className={`mt-1 ${FIELD}`}>
                <option value="" disabled>
                  Select a contributor
                </option>
                {activeContributors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.department_id ? ` · ${deptName.get(c.department_id) ?? ""}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-muted">
              Task
              <input
                name="title"
                required
                maxLength={300}
                placeholder="e.g. Edit 3 reels for Brand X"
                className={`mt-1 ${FIELD}`}
              />
            </label>
            <label className="text-[11px] text-ink-muted">
              Due (optional)
              <input name="due_date" type="date" className={`mt-1 ${FIELD}`} />
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
              >
                Assign
              </button>
            </div>
          </form>
        )}
      </SectionCard>

      {/* Moderator assignments — leadership only */}
      {isLeadership && (
        <SectionCard
          title="Moderator brand assignments"
          action={<Badge tone="muted">{assignments.length} assigned</Badge>}
        >
          <p className="mb-3 text-xs text-ink-muted">
            Give a teammate review access to a brand's host logs. They'll see that brand in the
            Moderation and Attendance queues. Leadership always sees every brand.
          </p>
          <form action={assignModerator} className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <label className="text-[11px] text-ink-muted">
              Teammate
              <select name="user_id" required defaultValue="" className={`mt-1 ${FIELD}`}>
                <option value="" disabled>
                  Select a person
                </option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name} · {p.role}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-ink-muted">
              Brand
              <select name="brand_id" required defaultValue="" className={`mt-1 ${FIELD}`}>
                <option value="" disabled>
                  Select a brand
                </option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
              >
                Assign
              </button>
            </div>
          </form>

          {assignments.length === 0 ? (
            <p className="py-2 text-sm text-ink-muted">No moderator assignments yet.</p>
          ) : (
            <TableShell columns={["Teammate", "Brand", ""]}>
              {assignments.map((a) => (
                <tr key={a.id} className={rowClass}>
                  <td className="p-3 text-ink">{personName.get(a.user_id) ?? "—"}</td>
                  <td className="p-3 text-ink-muted">{brandName.get(a.brand_id) ?? "—"}</td>
                  <td className="p-3 text-right">
                    <form action={removeModerator}>
                      <input type="hidden" name="id" value={a.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-red-300 hover:bg-charcoal-800"
                      >
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </TableShell>
          )}
        </SectionCard>
      )}
    </AppShell>
  );
}
