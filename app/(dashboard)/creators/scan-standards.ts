"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { lastCompletedIsoWeekManila } from "@/lib/metrics/windows";
import { computeStandardKpi, type StandardCreator, type TierRow } from "@/lib/affiliate/standards";
import { isBelowStandard, buildStandardsDraft } from "@/lib/actions/standards";

// The affiliate performance-standard loop's SIGNAL PRODUCER, behind the "Scan
// standards" button on the Creators/Affiliate page. It grades every creator who
// has an ACTIVE affiliate deal and a weekly posting commitment against their
// tier's standard and, for each one genuinely below it, DRAFTS one action_request
// (Tony's reasoning + a proposed create_standards_task) into the Action &
// Approval Queue for a human to approve. It never pauses a deal, never recovers
// product, never sends anything — a creator meeting the bar is simply not drafted.
//
// WINDOW — the LAST COMPLETED ISO week (Mon–Sun, Asia/Manila). This is the
// Monday-review semantics the loop is built for: you review the week that just
// ended on a full week's data, so a Monday-morning run never false-alarms on a
// current week that has barely started. Re-running mid-week (the daily huddle)
// re-checks the same completed week and is idempotent; live current-week pacing
// lives on the registry view, not in a drafted action.
//
// IDEMPOTENT — one request per creator per ISO week. A creator that already has
// an OPEN (pending/approved) affiliate request stamped with THIS iso_week is
// skipped, so re-scanning never duplicates. The iso_week tag also keeps this loop
// from colliding with the follow-up loop, whose affiliate requests carry no
// iso_week.
//
// RLS is the real guard: action_requests INSERT requires ceo/coo/department_head,
// so this action is gated to exactly that set. Every write stamps org_id from the
// caller's profile to pass the with_check. The affiliate tables aren't in the
// generated Database types, so they're reached through the same cast shim the
// delivery-risk and follow-up producers use.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface StandardsScanResult {
  scanned: number; // creators with an active deal + weekly commitment evaluated
  belowStandard: number; // creators found below standard this scan
  created: number; // new action_requests drafted
  skipped: number; // below-standard creators that already had an open request
  isoWeek: string; // the completed ISO week evaluated ("2026-W27")
  weekLabel: string; // e.g. "Jun 29 – Jul 5"
}

export async function scanStandards(): Promise<StandardsScanResult> {
  // Leadership / department heads only — the set RLS lets draft and approve the
  // resulting L2 department_head requests.
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;
  const week = lastCompletedIsoWeekManila();
  const startIso = new Date(week.startUtcMs).toISOString();
  const endIso = new Date(week.endUtcMs).toISOString(); // exclusive

  const [creatorsRes, tiersRes, dealsRes, postsRes, openRes] = await Promise.all([
    db
      .from("creators")
      .select("id, name, handle, tier, follower_count, posts_committed, attributed_gmv, owner_id"),
    db
      .from("creator_tiers")
      .select("tier, rank, min_following, max_following, min_gmv, gmv_period, required_post_rate_pct"),
    db.from("affiliate_deals").select("id, creator_id, status"),
    db
      .from("creator_posts")
      .select("creator_id")
      .eq("status", "posted")
      .gte("posted_at", startIso)
      .lt("posted_at", endIso),
    db
      .from("action_requests")
      .select("source_ref, status")
      .eq("source_module", "affiliate")
      .in("status", ["pending", "approved"]),
  ]);

  const creators = (creatorsRes.data ?? []) as StandardCreator[];
  const tiers = (tiersRes.data ?? []) as TierRow[];

  // First ACTIVE deal per creator → the deal_id carried into the draft/task.
  const activeDealByCreator = new Map<string, string>();
  for (const d of (dealsRes.data ?? []) as Array<{ id: string; creator_id: string | null; status: string }>) {
    if (d.status === "active" && d.creator_id && !activeDealByCreator.has(d.creator_id)) {
      activeDealByCreator.set(d.creator_id, d.id);
    }
  }

  // Delivered (posted) count per creator in the completed week.
  const deliveredByCreator = new Map<string, number>();
  for (const p of (postsRes.data ?? []) as Array<{ creator_id: string | null }>) {
    if (!p.creator_id) continue;
    deliveredByCreator.set(p.creator_id, (deliveredByCreator.get(p.creator_id) ?? 0) + 1);
  }

  // Idempotency: creator_ids that already carry an OPEN affiliate request for
  // THIS iso_week (ignores follow-up requests, which have no iso_week, and prior
  // weeks' standards requests).
  const openThisWeek = new Set<string>();
  for (const r of (openRes.data ?? []) as Array<{
    source_ref: { creator_id?: string; iso_week?: string } | null;
  }>) {
    if (r.source_ref?.iso_week === week.isoWeek && r.source_ref?.creator_id) {
      openThisWeek.add(r.source_ref.creator_id);
    }
  }

  let scanned = 0;
  let belowStandard = 0;
  let created = 0;
  let skipped = 0;

  for (const creator of creators) {
    const dealId = activeDealByCreator.get(creator.id);
    if (!dealId) continue; // no active deal — out of scope
    if (creator.posts_committed == null || creator.posts_committed <= 0) continue; // no weekly commitment
    scanned += 1;

    const kpi = computeStandardKpi({
      creator,
      tiers,
      delivered: deliveredByCreator.get(creator.id) ?? 0,
      hasEverPosted: true, // irrelevant to the flag; a completed 0/N week is a real miss
    });
    if (!isBelowStandard(kpi)) continue;
    belowStandard += 1;

    if (openThisWeek.has(creator.id)) {
      skipped += 1;
      continue;
    }

    const draft = buildStandardsDraft(creator, dealId, kpi, week);
    const { data: inserted, error } = await db
      .from("action_requests")
      .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
      .select("id")
      .single();
    if (error || !inserted?.id) continue;

    await writeActionAudit(db, {
      org_id: profile.org_id,
      action_request_id: inserted.id,
      event: "created",
      actor_id: null,
      actor_role: "system",
      detail: { source: "scan_standards", creator_id: creator.id, iso_week: week.isoWeek },
    });
    openThisWeek.add(creator.id); // guard against dupes within this same run
    created += 1;
  }

  revalidatePath("/approvals");
  revalidatePath("/creators");
  return {
    scanned,
    belowStandard,
    created,
    skipped,
    isoWeek: week.isoWeek,
    weekLabel: week.label,
  };
}
