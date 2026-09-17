import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, HelpHint } from "@/components/ui";
import { CouncilBoard, type BoardMember } from "@/components/council/CouncilBoard";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  readCouncilMembers,
  readMemberStatus,
  readLatestBriefs,
} from "@/lib/council/members";

// The Executive AI Council — one board under AI Platform. Each seeded council
// member (COO AI, CMO AI, CFO AI, …) renders as a card: name, title, domain, and
// a LIVE status light aggregated from its compartments' health via the Cognition
// Loop's own READ half. "Run [member]" runs that loop scoped to the member's
// compartment_codes, framed through its persona, and files ONE domain brief into
// the existing approval queue — recommendation-only, nothing auto-executes.
//
// This surface is leadership-focused (AI Platform): ceo/coo/department_head may
// reach it and run individual members (RLS gates the action_requests INSERT to
// that set); Run Full Council is ceo/coo only. Unmapped officers (empty
// compartment_codes: cto/bi/hr) show "scope pending" for v1.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

export default async function CouncilPage() {
  const profile = await requireRole(["ceo", "coo", "department_head"]);
  const db = createServerSupabaseClient() as unknown as Shim;

  const members = await readCouncilMembers(db);

  // Each member's live status + its latest filed brief, read in parallel. The
  // status uses the loop's deterministic READ (no model call) over the member's
  // compartments; latest briefs come from the org's council action_requests.
  const [statuses, latest] = await Promise.all([
    Promise.all(members.map((m) => readMemberStatus(db, m))),
    readLatestBriefs(db),
  ]);
  const statusByKey = new Map(statuses.map((s) => [s.key, s]));

  const boardMembers: BoardMember[] = members.map((m) => {
    const s = statusByKey.get(m.key);
    const brief = latest.get(m.key) ?? null;
    return {
      key: m.key,
      name: m.name,
      title: m.title,
      domain: m.domain,
      extraScope: m.extra_scope,
      mapped: s?.mapped ?? false,
      dot: s?.dot ?? null,
      grounded: s?.grounded ?? 0,
      total: s?.total ?? 0,
      latestBriefId: brief?.id ?? null,
      latestBriefStatus: brief?.status ?? null,
    };
  });

  const canRunFull = profile.role === "ceo" || profile.role === "coo";
  // The page is gated to the RLS INSERT set, so any viewer here may run a member.
  const canRun = true;

  return (
    <AppShell breadcrumb={["Mthryve OS", "AI Platform", "Executive Council"]} profile={profile}>
      <PageHeader
        title={<>Executive AI Council <HelpHint id="intelligence.council" /></>}
        subtitle={
          <>
            Six officer AIs, each the Cognition Loop scoped to its domain and framed through its own
            persona. Run one to file a grounded domain brief into the approval queue — every claim
            cites a real metric, an empty metric reads “—” and is never invented. Nothing
            auto-executes; a human approves (DECISIONS.md D-005).
          </>
        }
      />

      {boardMembers.length === 0 ? (
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
          No council members are provisioned yet.
        </div>
      ) : (
        <CouncilBoard members={boardMembers} canRun={canRun} canRunFull={canRunFull} />
      )}
    </AppShell>
  );
}
