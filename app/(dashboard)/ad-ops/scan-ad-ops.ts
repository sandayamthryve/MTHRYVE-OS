"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { last7 } from "@/lib/metrics/windows";
import { readAdPerformance } from "@/lib/ad-ops/performance";
import { evaluateCampaign, thresholdsFromEnv } from "@/lib/ad-ops/rules";
import { buildAdOpsDraft } from "@/lib/ad-ops/draft";

// Vesper's AD-OPS SIGNAL PRODUCER, behind the "Scan ad performance" button on
// the Ad Ops page. One click READS TikTok + Meta campaign performance over the
// last 7 days via Windsor.ai, evaluates each spending campaign against the rule
// engine, and DRAFTS one approval-gated action_request per winner/loser into
// the Action & Approval Queue. It NEVER pauses a campaign or moves a budget —
// Vesper drafts, a human (ceo/coo) approves, then the OS executes via Windsor.
//
// HONEST STATES: when Windsor isn't configured it drafts nothing and reports
// configured=false (the UI shows "ad connector not configured"). A Windsor read
// error for a platform is surfaced in `errors`, never masked with fake rows.
//
// IDEMPOTENT: one OPEN (pending/approved) request per (campaign, change). A
// campaign that already has an open pause/scale request is skipped, so
// re-scanning never stacks duplicates.
//
// RLS is the real guard: action_requests INSERT requires ceo/coo/department_head;
// these are money proposals (required_role='coo'), so the scan itself is gated
// to ceo/coo — the set that can also approve the results.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface AdOpsScanResult {
  configured: boolean;
  scanned: number; // campaigns evaluated (spending campaigns in scope)
  flagged: number; // campaigns the rules proposed a change on
  created: number; // new action_requests drafted
  skipped: number; // flagged campaigns that already had an open request
  windowLabel: string;
  errors: Array<{ platform: string; message: string }>;
}

export async function scanAdOps(): Promise<AdOpsScanResult> {
  // Leadership only — the set RLS lets draft and approve these L3 money actions.
  const profile = (await requireRole(["ceo", "coo"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;
  const window = last7();

  // Brands (id, name) back the env brand→account map; RLS scopes to the org.
  const { data: brandRows } = await db.from("brands").select("id, name");
  const brands = ((brandRows ?? []) as Array<{ id: string; name: string }>).map((b) => ({
    id: b.id,
    name: b.name,
  }));

  const perf = await readAdPerformance(brands, { datePreset: "last_7d" });
  if (!perf.configured) {
    return {
      configured: false,
      scanned: 0,
      flagged: 0,
      created: 0,
      skipped: 0,
      windowLabel: window.label,
      errors: [],
    };
  }

  // Existing OPEN ad_ops requests → keyed by "object_id::change" for idempotency.
  const { data: openRows } = await db
    .from("action_requests")
    .select("source_ref, status")
    .eq("source_module", "ad_ops")
    .in("status", ["pending", "approved"]);
  const openKeys = new Set<string>();
  for (const r of (openRows ?? []) as Array<{ source_ref: { object_id?: string; change?: string } | null }>) {
    const oid = r.source_ref?.object_id;
    const change = r.source_ref?.change;
    if (oid && change) openKeys.add(`${oid}::${change}`);
  }

  const thresholds = thresholdsFromEnv(7);
  let scanned = 0;
  let flagged = 0;
  let created = 0;
  let skipped = 0;

  for (const campaign of perf.rows) {
    // Only campaigns with meaningful spend are in scope (the rule engine also
    // enforces minSpend, but count "scanned" as the campaigns we truly weighed).
    if ((campaign.spend ?? 0) <= 0) continue;
    scanned += 1;

    const proposal = evaluateCampaign(campaign, thresholds);
    if (!proposal) continue;
    flagged += 1;

    const key = `${campaign.campaignId}::${proposal.change}`;
    if (openKeys.has(key)) {
      skipped += 1;
      continue;
    }

    const draft = buildAdOpsDraft(campaign, proposal, {
      start: window.start,
      end: window.end,
      label: window.label,
    });
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
      detail: {
        source: "scan_ad_ops",
        platform: campaign.platform,
        campaign_id: campaign.campaignId,
        change: proposal.change,
        signal: proposal.signal,
      },
    });
    openKeys.add(key); // guard against dupes within this same run
    created += 1;
  }

  revalidatePath("/ad-ops");
  revalidatePath("/approvals");
  return {
    configured: true,
    scanned,
    flagged,
    created,
    skipped,
    windowLabel: window.label,
    errors: perf.errors,
  };
}
