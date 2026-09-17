"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { todayManila } from "@/lib/metrics/windows";
import {
  isLeadDue,
  isCreatorDue,
  buildLeadFollowUpDraft,
  buildCreatorFollowUpDraft,
  type FollowUpLead,
  type FollowUpCreator,
} from "@/lib/actions/follow-ups";

// The poly-source follow-up loop's SIGNAL PRODUCER, shared by the "Scan
// follow-ups" button on BOTH the BizDev (leads) and Creators/Affiliate pages.
// One pass scans BOTH sources and, for every target genuinely due a touch,
// DRAFTS one action_request (Tony's reasoning + an editable follow-up message)
// into the Action & Approval Queue for a human to approve. It never sends
// anything and never fabricates — a target with no signal is simply not drafted.
//
//   • CLIENT LEADS   — open leads (not won/lost) with next_action_date <= today,
//                      or, when unscheduled, gone stale (> 7d / never contacted).
//   • AFFILIATE/KOL  — creators with an outreach_stage set and not signed/passed,
//                      same due rule.
//   • idempotent     — a lead/creator that already has an OPEN (pending/approved)
//                      request is skipped, so re-scanning never duplicates.
// A system 'created' audit row is written for each new draft (actor = system).
//
// RLS is the real guard: action_requests INSERT requires ceo/coo/department_head,
// so this action is gated to exactly that set (a team_member would be rejected by
// the policy anyway). Every write stamps org_id from the caller's profile to pass
// the with_check. The outreach tables aren't in the generated Database types, so
// they're reached through the same cast shim used across the app.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface FollowUpScanResult {
  scannedLeads: number; // open leads evaluated
  scannedCreators: number; // in-pipeline creators evaluated
  dueLeads: number; // leads found due this scan
  dueCreators: number; // creators found due this scan
  created: number; // new action_requests drafted
  skipped: number; // due targets that already had an open request
}

export async function scanFollowUps(): Promise<FollowUpScanResult> {
  // Only roles RLS lets INSERT an action_request (and that later approve the L2
  // department_head request) may run the scan.
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;
  const today = todayManila();
  const nowMs = Date.now();

  const [leadsRes, creatorsRes, openRes] = await Promise.all([
    db
      .from("leads")
      .select(
        "id, name, company, stage, value, owner_id, next_action, next_action_date, last_contacted_at"
      ),
    db
      .from("creators")
      .select(
        "id, name, handle, platform, follower_count, category, owner_id, outreach_stage, next_action, next_action_date, last_contacted_at"
      ),
    db
      .from("action_requests")
      .select("source_ref, source_module, status")
      .in("source_module", ["bizdev", "affiliate"])
      .in("status", ["pending", "approved"]),
  ]);

  const leads = (leadsRes.data ?? []) as FollowUpLead[];
  const creators = (creatorsRes.data ?? []) as FollowUpCreator[];

  // Idempotency: which lead/creator ids already carry an open request?
  const openLeadIds = new Set<string>();
  const openCreatorIds = new Set<string>();
  for (const r of (openRes.data ?? []) as Array<{
    source_ref: { lead_id?: string; creator_id?: string } | null;
  }>) {
    const lid = r.source_ref?.lead_id;
    if (lid) openLeadIds.add(lid);
    const cid = r.source_ref?.creator_id;
    if (cid) openCreatorIds.add(cid);
  }

  const dueLeads = leads.filter((l) => isLeadDue(l, today, nowMs));
  const dueCreators = creators.filter((c) => isCreatorDue(c, today, nowMs));

  let created = 0;
  let skipped = 0;

  for (const lead of dueLeads) {
    if (openLeadIds.has(lead.id)) {
      skipped += 1;
      continue;
    }
    const draft = buildLeadFollowUpDraft(lead, today, nowMs);
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
      detail: { source: "scan_follow_ups", lead_id: lead.id },
    });
    openLeadIds.add(lead.id); // guard against dupes within this same run
    created += 1;
  }

  for (const creator of dueCreators) {
    if (openCreatorIds.has(creator.id)) {
      skipped += 1;
      continue;
    }
    const draft = buildCreatorFollowUpDraft(creator, today, nowMs);
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
      detail: { source: "scan_follow_ups", creator_id: creator.id },
    });
    openCreatorIds.add(creator.id);
    created += 1;
  }

  revalidatePath("/approvals");
  revalidatePath("/outreach");
  revalidatePath("/creators");
  return {
    scannedLeads: leads.length,
    scannedCreators: creators.length,
    dueLeads: dueLeads.length,
    dueCreators: dueCreators.length,
    created,
    skipped,
  };
}
