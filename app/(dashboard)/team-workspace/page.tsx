import Link from "next/link";

import { AppShell } from "@/components/layout/AppShell";
import { LogWork } from "@/components/team-workspace/LogWork";
import { requireModule } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { workspaceRoleForProfile, type WorkspaceRole } from "@/lib/auth/module-access";
import { DEPARTMENT_WORKSPACES, toolState, visibleWorkspaces, workspaceForRole } from "@/lib/team-workspace/config";
import { fetchDepartmentQueue, fetchTodaysLog } from "@/lib/team-workspace/data";

// The Team Workspace — one screen per department scope: the tools it reaches
// for, the work it owes today, and where it logs what it did.
//
// Scope is resolved from the session, never from the URL alone. ?dept= only
// selects among the departments the viewer may already see (Operator: all, a
// department scope: its own), so a hand-typed ?dept=finance cannot open
// Finance's queue to HR.

export const dynamic = "force-dynamic";

type Shim = { from: (table: string) => any };

const STATUS_LABELS: Record<string, string> = {
  todo: "TO DO",
  in_progress: "IN PROGRESS",
  blocked: "BLOCKED",
};

const STATUS_DOT: Record<string, string> = {
  todo: "bg-[#4b5b68]",
  in_progress: "bg-[#f5b544]",
  blocked: "bg-[#f87171]",
};

export default async function TeamWorkspacePage({
  searchParams,
}: {
  searchParams: { dept?: string };
}) {
  const profile = await requireModule("/team-workspace");
  const role = (profile.preview_role ?? workspaceRoleForProfile(profile) ?? "operator") as WorkspaceRole;

  const available = visibleWorkspaces(role);
  const requested = (searchParams.dept ?? "").trim();
  // Only ever a department this viewer already has; otherwise the first one.
  const active =
    available.find((entry) => entry.role === requested) ??
    available[0] ??
    workspaceForRole("hr")!;

  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // The queue belongs to the department being viewed; the log belongs to the
  // person viewing. Operator previewing Finance sees Finance's work and its own
  // log, because a preview must not write into someone else's day.
  let departmentId: string | null = null;
  try {
    const { data } = await db
      .from("departments")
      .select("id")
      .eq("org_id", profile.org_id)
      .eq("name", active.label === "E-Commerce Specialist" ? "E-Commerce Ops" : active.label)
      .maybeSingle();
    departmentId = (data as { id: string } | null)?.id ?? profile.department_id;
  } catch {
    departmentId = profile.department_id;
  }

  const [queue, log] = await Promise.all([
    fetchDepartmentQueue(db, profile.org_id, departmentId),
    fetchTodaysLog(db, profile.org_id, profile.id),
  ]);

  const showTabs = available.length > 1;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Team Workspace"]} profile={profile}>
      {showTabs && (
        <nav aria-label="Department workspaces" className="mb-6 flex flex-wrap gap-2">
          {DEPARTMENT_WORKSPACES.map((entry) => {
            const isActive = entry.role === active.role;
            return (
              <Link
                key={entry.role}
                href={`/team-workspace?dept=${entry.role}`}
                aria-current={isActive ? "page" : undefined}
                className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] font-extrabold transition ${
                  isActive
                    ? "border-transparent bg-gradient-to-br from-[#2dd4bf] to-[#3ecf8e] text-[#04120c]"
                    : "border-[#20313c] bg-[#0d141b] text-[#e9f0f6] hover:border-[#2dd4bf]/45"
                }`}
              >
                <span aria-hidden>{entry.icon}</span>
                {entry.label}
              </Link>
            );
          })}
        </nav>
      )}

      <section className="mb-6 rounded-2xl border border-[#20313c] bg-[#0b1319] p-5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="text-[19px] font-black tracking-tight text-[#e9f0f6]">
            <span aria-hidden>{active.icon}</span> {active.label}
          </h1>
          <p className="text-[13px] text-[#8b9aa8]">
            · {active.staff} · co-pilot: {active.copilot}
          </p>
        </div>

        <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-[#2dd4bf]">
          🧰 Their tools — one click, opens in-app
        </p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {active.tools.map((tool) => {
            const state = toolState(role, tool);
            if (state.disabled) {
              return (
                <div
                  key={tool.label}
                  aria-disabled="true"
                  title={`${tool.label} — ${state.reason}`}
                  className="grid min-h-[104px] cursor-not-allowed place-items-center rounded-2xl border border-[#1a2731] bg-[#0a1016] p-4 text-center opacity-40"
                >
                  <span aria-hidden className="text-[18px]">⚙</span>
                  <span className="text-[14px] font-extrabold text-[#e9f0f6]">{tool.label}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wide text-[#6f8491]">{state.reason}</span>
                </div>
              );
            }
            return (
              <Link
                key={tool.label}
                href={state.href}
                className="grid min-h-[104px] place-items-center rounded-2xl border border-[#20313c] bg-[#0d141b] p-4 text-center transition hover:-translate-y-px hover:border-[#2dd4bf]/45 hover:bg-[#0d171e]"
              >
                <span aria-hidden className="text-[18px] text-[#8b9aa8]">⚙</span>
                <span className="text-[14px] font-extrabold text-[#e9f0f6]">{tool.label}</span>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-[#20313c] bg-[#0b1319] p-5">
          <header className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-[15px] font-extrabold text-[#e9f0f6]">✅ Today&apos;s work queue</h2>
            <p className="text-[12.5px] text-[#8b9aa8]">· where they DO the work</p>
          </header>

          {queue.length === 0 ? (
            <p className="text-[12.5px] text-[#6f8491]">
              Nothing open for {active.label} right now. Tasks assigned to this department appear
              here while they are to do, in progress or blocked.
            </p>
          ) : (
            <ul className="space-y-3">
              {queue.map((item) => (
                <li key={item.id} className="rounded-xl border border-[#1e2a35] bg-[#0d141b] p-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[item.status] ?? "bg-[#4b5b68]"}`} />
                    <h3 className="text-[14px] font-extrabold text-[#e9f0f6]">{item.title}</h3>
                    <span className="text-[10px] font-black uppercase tracking-[0.14em] text-[#8b9aa8]">
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                    {item.assignee && (
                      <span className="text-[11px] text-[#6f8491]">· {item.assignee}</span>
                    )}
                  </div>
                  {item.brief && (
                    <p className="mt-2 border-l-2 border-[#a78bfa]/60 pl-3 text-[12.5px] text-[#b6c2cd]">
                      <b className="text-[#b9abf8]">{active.copilot.split(" + ")[0]} brief:</b> {item.brief}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <LogWork entries={log.entries} filed={log.filed} />
      </div>
    </AppShell>
  );
}
