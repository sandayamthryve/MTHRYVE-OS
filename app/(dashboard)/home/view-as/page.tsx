import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadMyDay, loadDeptCockpit, loadOperations } from "@/lib/home/cockpit";
import { MyDayView, DeptCockpitView, OperationsView } from "@/components/home/cockpit-views";
import { ViewAsBanner } from "@/components/home/ViewAsBanner";
import { loadMissionControl } from "@/lib/ceo/mission-control";
import type { UserRole } from "@/types/database";

// Leadership View-As (CEO / COO ONLY). A person picker renders any org user's home
// READ-ONLY, via leadership-scoped reads (org + that user_id). A persistent banner
// says whose home it is; NO write control renders anywhere beneath it — the
// cockpit views are handed no write slots, so only reads show. Every open inserts
// a home_view_audit row (viewer_id defaults to auth.uid()).
export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };
type TargetUser = { id: string; full_name: string; role: UserRole; department_id: string | null };

const ROLE_LABEL: Record<UserRole, string> = {
  ceo: "CEO",
  coo: "COO",
  department_head: "Department Head",
  team_member: "Team Member",
};

const ROLE_TONE: Record<UserRole, "teal" | "violet" | "amber" | "muted"> = {
  ceo: "teal",
  coo: "violet",
  department_head: "amber",
  team_member: "muted",
};

export default async function ViewAsPage({ searchParams }: { searchParams?: { user?: string } }) {
  const profile = await requireRole(["ceo", "coo"]);
  const supabase = createServerSupabaseClient();
  const targetId = (searchParams?.user ?? "").trim();

  // ── No selection → the person picker ────────────────────────────────────────
  if (!targetId) {
    const { data } = await supabase
      .from("users")
      .select("id, full_name, role, department_id")
      .eq("org_id", profile.org_id)
      .order("full_name");
    const people = ((data ?? []) as unknown as TargetUser[]) ?? [];

    return (
      <AppShell breadcrumb={["Mthryve OS", "View As"]} profile={profile}>
        <PageHeader
          title="Leadership View-As"
          subtitle="Open any teammate's home exactly as they see it — read-only. Every view is audited."
        />
        <SectionCard title="Pick a person">
          {people.length === 0 ? (
            <p className="text-sm text-ink-muted">No users in your organization yet.</p>
          ) : (
            <ul className="divide-y divide-charcoal-800">
              {people.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/home/view-as?user=${p.id}`}
                    className="flex items-center justify-between gap-3 py-3 hover:text-teal-300"
                  >
                    <span className="truncate text-sm text-ink">{p.full_name}</span>
                    <Badge tone={ROLE_TONE[p.role]}>{ROLE_LABEL[p.role]}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </AppShell>
    );
  }

  // ── Selection → leadership-scoped read of that user (org + user_id) ──────────
  const { data: targetRow } = await supabase
    .from("users")
    .select("id, full_name, role, department_id")
    .eq("org_id", profile.org_id)
    .eq("id", targetId)
    .maybeSingle();
  const target = (targetRow as TargetUser | null) ?? null;

  if (!target) {
    return (
      <AppShell breadcrumb={["Mthryve OS", "View As"]} profile={profile}>
        <PageHeader title="Leadership View-As" subtitle="That person isn't in your organization." />
        <SectionCard title="Not found">
          <p className="text-sm text-ink-muted">
            No such user in your org.{" "}
            <Link href="/home/view-as" className="text-teal-300 hover:text-teal-200">
              Back to the picker
            </Link>
            .
          </p>
        </SectionCard>
      </AppShell>
    );
  }

  // Audit every open — one home_view_audit row per view (viewer_id + viewed_at
  // default in the table). A failed insert never blocks the read-only view.
  try {
    await (supabase as unknown as Shim).from("home_view_audit").insert({
      org_id: profile.org_id,
      viewed_user_id: target.id,
      context: "leadership_view_as",
    });
  } catch {
    /* audit is best-effort — never sink the view */
  }

  const banner = <ViewAsBanner name={target.full_name} roleLabel={ROLE_LABEL[target.role]} />;

  // Render the target's OWN home, read-only (no write slots passed → no controls).
  let body: React.ReactNode;
  if (target.role === "team_member") {
    const data = await loadMyDay(supabase, {
      userId: target.id,
      departmentId: target.department_id,
    });
    body = <MyDayView data={data} />;
  } else if (target.role === "department_head") {
    const data = await loadDeptCockpit(supabase, {
      orgId: profile.org_id,
      departmentId: target.department_id,
    });
    body = <DeptCockpitView data={data} />;
  } else {
    // ceo / coo home → the leadership Operations overview, read-only.
    const [data, mc] = await Promise.all([
      loadOperations(supabase, { orgId: profile.org_id }),
      loadMissionControl(supabase, profile.org_id),
    ]);
    body = <OperationsView data={data} deptHealth={mc.deptHealth} />;
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "View As", target.full_name]} profile={profile}>
      {banner}
      <PageHeader
        title={`${target.full_name}'s home`}
        subtitle={`${ROLE_LABEL[target.role]} · read-only leadership view`}
      />
      {body}
    </AppShell>
  );
}
