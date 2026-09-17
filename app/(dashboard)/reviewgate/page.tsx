import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { ReviewGateQueue } from "@/components/people/ReviewGateQueue";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isDevChannelAuthBypassEnabled } from "@/lib/auth/dev-channel";
import { canDecide, type ActionRequestRow } from "@/lib/actions/types";
import { isHrGateRow, sortForGate, sortItems, toReviewGateItem } from "@/lib/people/review-gate";
import { REVIEW_GATE_PREVIEW } from "@/lib/people/review-gate-preview";

// The People Review Gate.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES. This page is the people-class face of that spine: every
// pending action_request whose action_class is 'people' — anything that touches
// a person's status — lands in ONE queue with a preview and an Approve /
// Request changes tap, instead of being chased across six surfaces.
//
// The gate is by CLASS, not by agent, and the DB derives the class
// (tg_action_class_gate) and floors required_role to leadership. RLS on
// action_requests stays the real authority for who may decide; canDecide() only
// decides whether we render live buttons, so we never show a control the policy
// would reject. Because the floor is leadership, a preview role other than
// Operator resolves to team_member and sees this queue read-only — that is the
// policy working, not a bug. Giving a department the power to decide here is an
// authority change (required_role / account role), not a UI one.
//
// Governed permanent-deletes (source_module='governance') walk a sequential
// COO → CEO chain and keep their dedicated card on /approvals — they are held
// out of this single-step queue.
//
// This lives on its own top-level route rather than on /people. An earlier cut
// put the queue ON the People page and was reverted (b988c87) because it
// displaced the contractor roster; the roster keeps /people and the two link to
// each other. It sat at /people/review-gate until it was promoted to
// /reviewgate, so it is a module in its own right now, not a child of People.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

export default async function PeopleReviewGatePage() {
  const profile = await requireModule("/reviewgate");
  const devChannel = isDevChannelAuthBypassEnabled();

  // action_requests isn't in the generated Database types yet, so it's reached
  // through the same cast shim the Live, Contracts and Approvals modules use.
  // A read failure must not take the page down — the gate degrades to its empty
  // state (and, on the devchannel, to the preview rows below).
  let rows: ActionRequestRow[] = [];
  try {
    const db = createServerSupabaseClient() as unknown as Shim;
    const { data } = await db.from("action_requests").select("*");
    rows = (data ?? []) as unknown as ActionRequestRow[];
  } catch {
    rows = [];
  }

  const items = sortForGate(rows.filter(isHrGateRow)).map((row) =>
    toReviewGateItem(row, canDecide(profile.role, row.required_role))
  );

  // The devchannel runs on a fixed in-memory reviewer with no Supabase session,
  // so there is nothing to read. Fall back to inert sample rows there — and ONLY
  // there — so the queue can actually be reviewed. See review-gate-preview.ts.
  const usingPreview = devChannel && items.length === 0;
  // Preview rows are people-class, so the DB would floor them to leadership —
  // re-check the caller against that floor rather than shipping a card with live
  // buttons a real policy would reject.
  const shown = sortItems(
    usingPreview
      ? REVIEW_GATE_PREVIEW.map((item) => ({
          ...item,
          canDecide: canDecide(profile.role, "coo"),
        }))
      : items
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "People", "Review Gate"]} profile={profile}>
      <ReviewGateQueue
        firstName={profile.full_name.split(/\s+/)[0] || "there"}
        items={shown}
        rosterHref="/people"
        isPreview={usingPreview}
      />
    </AppShell>
  );
}
