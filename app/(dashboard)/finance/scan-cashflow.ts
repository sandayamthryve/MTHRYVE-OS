"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { currentIsoWeekManila } from "@/lib/metrics/windows";
import { loadCashflow } from "@/lib/finance/data";
import { isForecastDeficit, buildCashflowDraft } from "@/lib/finance/signal";
import { DEFAULT_HORIZON_DAYS } from "@/lib/finance/forecast";

// The Cash-Flow Deficit loop's SIGNAL PRODUCER, behind the "Scan cash flow"
// button on the Finance page. One click runs the SHARED forecast engine over the
// latest cash position (the same projection the view shows) and, IF a deficit is
// projected inside the horizon, DRAFTS one action_request into the Action &
// Approval Queue for a human to approve.
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS, a human APPROVES, then
// the OS EXECUTES — and the executor only ever opens an internal task. This
// producer moves, transfers and borrows nothing. A forecast that stays
// cash-positive drafts nothing; a run with no cash position set drafts nothing.
//
// IDEMPOTENT — one cash-flow draft per ISO week. If a finance request already
// exists for the current week (pending, approved or executed), the scan skips
// rather than stacking duplicates. RLS is the real guard: finance reads and
// action_requests INSERT both require ceo/coo, so this action is gated to that
// set and every write stamps org_id from the caller's profile.

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface CashflowScanResult {
  hasAnchor: boolean; // was a cash position set?
  deficit: boolean; // did the forecast project a deficit in the horizon?
  created: number; // new action_requests drafted (0 or 1)
  skipped: boolean; // a draft already existed for this week
  runwayDays: number | null;
  deficitDate: string | null;
}

export async function scanCashflow(): Promise<CashflowScanResult> {
  // Leadership only — the set RLS lets draft and approve the resulting L3
  // coo-required finance requests.
  const profile = (await requireRole(["ceo", "coo"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  // Run the shared engine at the DEFAULT horizon so the weekly signal is stable
  // regardless of whatever horizon the viewer happens to have selected.
  const { anchor, forecast } = await loadCashflow(db, profile.org_id, {
    horizonDays: DEFAULT_HORIZON_DAYS,
    actorRole: profile.role,
    actorId: profile.id,
  });

  if (!anchor || !forecast) {
    return { hasAnchor: false, deficit: false, created: 0, skipped: false, runwayDays: null, deficitDate: null };
  }
  if (!isForecastDeficit(forecast)) {
    return {
      hasAnchor: true,
      deficit: false,
      created: 0,
      skipped: false,
      runwayDays: forecast.runwayDays,
      deficitDate: forecast.deficitDate,
    };
  }

  const isoWeek = currentIsoWeekManila().isoWeek;

  // Idempotency: has a finance request already been raised for this ISO week?
  // Fetch this org's live/decided finance requests and check in-app (mirrors the
  // warehouse producer's approach) rather than trusting a jsonb filter.
  const { data: existing } = await db
    .from("action_requests")
    .select("source_ref, status")
    .eq("source_module", "finance")
    .in("status", ["pending", "approved", "executed"]);
  const alreadyThisWeek = ((existing ?? []) as Array<{
    source_ref: { iso_week?: string } | null;
  }>).some((r) => r.source_ref?.iso_week === isoWeek);

  if (alreadyThisWeek) {
    return {
      hasAnchor: true,
      deficit: true,
      created: 0,
      skipped: true,
      runwayDays: forecast.runwayDays,
      deficitDate: forecast.deficitDate,
    };
  }

  const draft = buildCashflowDraft(forecast, isoWeek);

  const { data: inserted, error } = await db
    .from("action_requests")
    .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
    .select("id")
    .single();

  if (error || !(inserted as { id?: string } | null)?.id) {
    return {
      hasAnchor: true,
      deficit: true,
      created: 0,
      skipped: false,
      runwayDays: forecast.runwayDays,
      deficitDate: forecast.deficitDate,
    };
  }
  const requestId = (inserted as { id: string }).id;

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: requestId,
    event: "created",
    actor_id: null,
    actor_role: "system",
    detail: {
      source: "scan_cashflow",
      iso_week: isoWeek,
      deficit_date: forecast.deficitDate,
      runway_days: forecast.runwayDays,
      projected_shortfall: forecast.projectedShortfall,
    },
  });

  revalidatePath("/approvals");
  revalidatePath("/finance");
  return {
    hasAnchor: true,
    deficit: true,
    created: 1,
    skipped: false,
    runwayDays: forecast.runwayDays,
    deficitDate: forecast.deficitDate,
  };
}
