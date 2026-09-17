import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, StatTile, TableShell, rowClass, type BadgeTone, HelpHint } from "@/components/ui";
import { ContractorEditor, type ContractorPerson } from "@/components/people/ContractorEditor";
import { MakePermanentButton } from "@/components/people/MakePermanentButton";
import { isProbationary, probationDaysLeft } from "@/lib/auth/session";
import { canManageProbation } from "@/lib/people/probation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { UserRole } from "@/types/database";

type Person = {
  id: string;
  full_name: string;
  email: string;
  position: string | null;
  role: UserRole;
  department_id: string | null;
  contractor_code: string | null;
  employment_status: string | null;
  probation_end: string | null;
  date_started: string | null;
  base_pay: number | null;
  commission_structure: string | null;
  compensation_frequency: string | null;
  supervisor_id: string | null;
  team_assignment: string | null;
  mobile: string | null;
  home_address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_number: string | null;
  telegram_username: string | null;
};

type Dept = { id: string; name: string };

const ROLE_LABELS: Record<UserRole, string> = {
  ceo: "CEO",
  coo: "COO",
  department_head: "Department Head",
  team_member: "Team Member",
};
const ROLE_TONES: Record<UserRole, BadgeTone> = {
  ceo: "violet",
  coo: "teal",
  department_head: "amber",
  team_member: "muted",
};

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

export default async function PeoplePage({ searchParams }: { searchParams: { dept?: string } }) {
  const profile = await requireModule("/people");
  const canEdit = profile.role === "ceo" || profile.role === "coo";
  const canSeePay = profile.role === "ceo" || profile.role === "coo";
  const canPromote = profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const deptId = (searchParams.dept ?? "").trim();
  const supabase = createServerSupabaseClient();

  const canProbation = await canManageProbation(
    supabase as unknown as { from: (t: string) => any },
    profile
  );

  const [usersRes, deptRes] = await Promise.all([
    supabase
      .from("users")
      .select(
        "id, full_name, email, position, role, department_id, contractor_code, employment_status, probation_end, date_started, base_pay, commission_structure, compensation_frequency, supervisor_id, team_assignment, mobile, home_address, emergency_contact_name, emergency_contact_number, telegram_username"
      )
      .order("full_name"),
    supabase.from("departments").select("id, name").order("name"),
  ]);

  const people = (usersRes.data ?? []) as unknown as Person[];
  const departments = (deptRes.data ?? []) as unknown as Dept[];
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const nameById = new Map(people.map((p) => [p.id, p.full_name]));
  const supervisors = people.map((p) => ({ id: p.id, name: p.full_name }));

  const headcount = people.length;
  const coded = people.filter((p) => p.contractor_code).length;
  const deptCounts = departments.map((d) => ({
    name: d.name,
    count: people.filter((p) => p.department_id === d.id).length,
  }));
  const noDeptCount = people.filter((p) => !p.department_id).length;
  const rows = deptId ? people.filter((p) => p.department_id === deptId) : people;

  const columns = ["Code", "Name", "Job Title", "Department", "Status", "Supervisor"];
  if (canSeePay) columns.push("Base pay");
  columns.push("Role");
  if (canEdit) columns.push("");

  return (
    <AppShell breadcrumb={["Mthryve OS", "People"]} profile={profile}>
      <PageHeader
        title={<>People <HelpHint id="people.probation" /></>}
        subtitle="Your complete contractor roster. Review headcount, department assignments, employment status, supervisors, roles and compensation details from one place."
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Headcount" value={headcount} hint="Total contractors" />
          <StatTile label="Coded" value={coded} hint={`of ${headcount} have a code`} />
          {deptCounts.slice(0, 2).map((d) => (
            <StatTile key={d.name} label={d.name} value={d.count} hint="People" />
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link
            href="/reviewgate"
            className="shrink-0 rounded-md bg-charcoal-800 px-3 py-2 text-sm font-semibold text-teal-300 hover:bg-charcoal-700"
          >
            Review Gate →
          </Link>
          {canProbation && (
            <Link
              href="/people/probation"
              className="shrink-0 rounded-md bg-charcoal-800 px-3 py-2 text-sm font-semibold text-teal-300 hover:bg-charcoal-700"
            >
              Probation queue →
            </Link>
          )}
        </div>
      </div>

      {(deptCounts.length > 2 || noDeptCount > 0) && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {deptCounts.slice(2).map((d) => (
            <StatTile key={d.name} label={d.name} value={d.count} hint="People" />
          ))}
          {noDeptCount > 0 && <StatTile label="Unassigned" value={noDeptCount} hint="No department" />}
        </div>
      )}

      <form action="/people" method="get" className="mb-6 flex gap-2">
        <select
          name="dept"
          defaultValue={deptId}
          className="w-full max-w-sm rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
        >
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
        >
          Filter
        </button>
      </form>

      <TableShell columns={columns}>
        {rows.length === 0 && (
          <tr>
            <td colSpan={columns.length} className="p-4 text-ink-muted">No people match this filter.</td>
          </tr>
        )}
        {rows.map((p) => (
          <tr key={p.id} className={rowClass}>
            <td className="p-3">
              {p.contractor_code ? <span className="font-mono text-xs text-teal-300">{p.contractor_code}</span> : <span className="font-mono text-xs text-ink-dim">—</span>}
            </td>
            <td className="p-3"><div className="text-ink">{p.full_name}</div><div className="text-xs text-ink-muted">{p.email}</div></td>
            <td className="p-3 text-ink-muted">{p.position ?? "—"}</td>
            <td className="p-3 text-ink-muted">{p.department_id ? deptName.get(p.department_id) ?? "—" : "—"}</td>
            <td className="p-3 text-ink-muted">
              {isProbationary(p.employment_status) ? (() => {
                const daysLeft = probationDaysLeft(p);
                const lapsed = daysLeft !== null && daysLeft < 0;
                return (
                  <div className="flex flex-col items-start gap-1.5">
                    <Badge tone={lapsed ? "red" : "amber"}>
                      {lapsed ? "Probation ended · suspended" : daysLeft === null ? "Probationary" : daysLeft === 0 ? "Probationary · last day" : `Probationary · ${daysLeft}d left`}
                    </Badge>
                    {canPromote && <MakePermanentButton personId={p.id} />}
                  </div>
                );
              })() : p.employment_status ?? "—"}
            </td>
            <td className="p-3 text-ink-muted">{p.supervisor_id ? nameById.get(p.supervisor_id) ?? "—" : "—"}</td>
            {canSeePay && <td className="p-3 font-mono text-ink-muted">{p.base_pay != null ? peso(Number(p.base_pay)) : "—"}</td>}
            <td className="p-3"><Badge tone={ROLE_TONES[p.role]}>{ROLE_LABELS[p.role]}</Badge></td>
            {canEdit && (
              <td className="p-3">
                <ContractorEditor person={p as ContractorPerson} departments={departments} supervisors={supervisors} canSeePay={canSeePay} />
              </td>
            )}
          </tr>
        ))}
      </TableShell>
    </AppShell>
  );
}
