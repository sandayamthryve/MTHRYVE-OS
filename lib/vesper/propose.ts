// lib/vesper/propose.ts — the Tony → Vesper handoff.
//
// Tony PLANS: he proposes a "play" as a PENDING action_request on the existing
// approval spine (source_module = 'tony_plan', proposed_action.type = one of the
// six Vesper executor types). A human approves in the Approval Queue and the
// executor (lib/actions/executor.ts) runs Vesper's runner — writing the
// action_audit row. This module is the single place that FILES that request, so
// the chat agent (/api/vesper) and the UI's "Propose play" button behave
// identically.
//
// The file runs on the CALLER's RLS-scoped client: action_requests INSERT is
// ceo/coo/department_head only (RLS ar_insert), so a team member simply can't
// file a play — matching the pods write gate.
//
// AUTO-RUN: default OFF (see AUTO_RUN_LOW_RISK). When enabled, a low-risk
// read-only play is approved-and-run immediately AFTER filing — it never skips
// the spine: it still becomes an action_request, still flips to approved, and
// still executes through executeApprovedAction with its audit trail. The default
// path leaves the request pending for a human.

import { writeActionAudit } from "@/lib/actions/audit";
import { executeApprovedAction } from "@/lib/actions/executor";
import type { ActionRequestRow } from "@/lib/actions/types";
import {
  isVesperPlayType,
  shouldAutoRun,
  vesperPlay,
  VESPER_SOURCE_MODULE,
  type VesperPlayType,
} from "@/lib/vesper/plays";

type Shim = { from: (t: string) => any };

export interface FilePlayArgs {
  orgId: string;
  actorId: string; // the proposer (created_by)
  actorRole: string;
  playType: string;
  params?: Record<string, unknown>;
  // Optional human-readable title override; otherwise derived from the play.
  title?: string;
}

export interface FilePlayResult {
  ok: boolean;
  id?: string;
  title?: string;
  status?: string; // 'pending' | 'executed' | 'failed'
  autoRan?: boolean;
  result?: Record<string, unknown> | null;
  error?: string;
  routed?: boolean;
}

// A short, honest title from the play + its most identifying params.
function titleFor(playType: VesperPlayType, params: Record<string, unknown>): string {
  const spec = vesperPlay(playType);
  const bits: string[] = [];
  if (typeof params.sku === "string" && params.sku) bits.push(params.sku);
  const pillar = params.pillar ?? (Array.isArray(params.pillars) ? params.pillars.join("/") : undefined);
  if (typeof pillar === "string" && pillar) bits.push(pillar);
  if (typeof params.campaign === "string" && params.campaign) bits.push(params.campaign);
  return bits.length ? `${spec.label}: ${bits.join(" · ")}` : spec.label;
}

export async function fileVesperPlay(db: Shim, args: FilePlayArgs): Promise<FilePlayResult> {
  if (!isVesperPlayType(args.playType)) {
    return { ok: false, error: `Unknown play "${args.playType}".` };
  }
  const playType = args.playType;
  const spec = vesperPlay(playType);
  const params = (args.params ?? {}) as Record<string, unknown>;
  const title = (args.title ?? "").trim() || titleFor(playType, params);

  const draft = {
    org_id: args.orgId,
    created_by: args.actorId,
    source_module: VESPER_SOURCE_MODULE,
    source_ref: { play: playType, by_role: args.actorRole },
    title,
    problem: null,
    recommendation: spec.description,
    confidence: 0.7,
    risk_tier: spec.riskTier,
    required_role: spec.requiredRole,
    status: "pending",
    proposed_action: { type: playType, payload: params },
  };

  const { data, error } = await db
    .from("action_requests")
    .insert(draft)
    .select("*")
    .single();

  if (error) {
    // An RLS rejection means this role can't file plays (not leadership).
    return {
      ok: false,
      routed: true,
      error:
        "You don't have permission to file a play — approvals are leadership-gated (ceo/coo/department_head).",
    };
  }

  const row = data as ActionRequestRow;
  await writeActionAudit(db, {
    org_id: args.orgId,
    action_request_id: row.id,
    event: "created",
    actor_id: args.actorId,
    actor_role: args.actorRole,
    detail: { source: "tony_plan", play: playType, params },
  });

  // Default path: leave it pending for a human. Approval path stays intact.
  if (!shouldAutoRun(playType)) {
    return { ok: true, id: row.id, title, status: "pending", autoRan: false };
  }

  // Auto-run (low-risk, read-only, and only when AUTO_RUN_LOW_RISK is on): flip
  // to approved and execute through the SAME spine + audit.
  const decidedAt = new Date().toISOString();
  const { data: approved } = await db
    .from("action_requests")
    .update({ status: "approved", decided_by: args.actorId, decided_at: decidedAt, updated_at: decidedAt })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  const approvedRow = (approved as ActionRequestRow | null) ?? { ...row, decided_by: args.actorId };
  // The 'approved' spine row is written at the DB by tg_action_decision_audit on
  // the pending→approved transition (the 'created' row above already recorded the
  // play + params), so the auto-run path no longer writes it here.
  const exec = await executeApprovedAction(approvedRow as ActionRequestRow);
  return {
    ok: exec.ok,
    id: row.id,
    title,
    status: exec.ok ? "executed" : "failed",
    autoRan: true,
    result: exec.result ?? null,
    error: exec.ok ? undefined : exec.error,
  };
}
