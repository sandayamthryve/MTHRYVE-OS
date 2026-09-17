"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { writeActionAudit } from "@/lib/actions/audit";
import { TIER_MODEL, defaultTierFor } from "@/lib/ai/models";
import { readCompartmentScope } from "@/lib/cognition/scope";
import { runCognitionPlan, isThinScope } from "@/lib/cognition/plan";
import { logCognitionUsage } from "@/lib/cognition/usage";
import {
  readCouncilMember,
  readCouncilMembers,
  isMapped,
  lensFor,
  memberDraft,
  type CouncilMember,
} from "@/lib/council/members";

// The Executive AI Council's SIGNAL PRODUCER. "Run [member]" runs the Cognition
// Loop scoped to that officer's compartment_codes, framed through the member's
// persona (the lens), and files ONE domain brief into the EXISTING approval
// spine (action_requests, source_module='council', source_ref=<member key>).
//
// This is NOT a parallel engine: it reuses lib/cognition end-to-end (READ →
// PLAN → planToDraft) and only re-stamps the row as a council brief. Every brief
// is recommendation-only (proposed_action null) — a human approves, NOTHING
// auto-executes. RLS is the real guard: action_requests INSERT requires
// ceo/coo/department_head, so runs are gated to that set; Run Full Council is
// leadership-only (ceo/coo).

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

export interface CouncilRunResult {
  ok: boolean;
  memberKey: string;
  memberName: string;
  created: number; // 1 when a brief was filed, else 0
  scopePending: boolean; // member has no compartment_codes yet (cto/bi/hr)
  thin: boolean; // scope has no real entries — nothing to reason over
  grounded: number;
  total: number;
  scopeLabel: string;
  requestId: string | null;
  error?: string;
}

function pendingResult(member: CouncilMember, extra: Partial<CouncilRunResult>): CouncilRunResult {
  return {
    ok: true,
    memberKey: member.key,
    memberName: member.name,
    created: 0,
    scopePending: false,
    thin: false,
    grounded: 0,
    total: 0,
    scopeLabel: member.domain,
    requestId: null,
    ...extra,
  };
}

// Run ONE mapped member end-to-end. Shared by the single-member button and Run
// Full Council. Assumes the caller already passed the RLS role gate.
async function runOneMember(
  db: Shim,
  profile: Profile,
  member: CouncilMember
): Promise<CouncilRunResult> {
  // Unmapped officers (empty compartment_codes) show "scope pending" — never run,
  // never spend a model call, never invent a brief.
  if (!isMapped(member)) {
    return pendingResult(member, { scopePending: true });
  }

  const scope = await readCompartmentScope(db, member.compartment_codes);
  const base = {
    grounded: scope.grounded,
    total: scope.readings.length,
    scopeLabel: scope.label,
  };

  // Too thin to plan → honest no-op (no spend, no fabricated brief).
  if (isThinScope(scope)) {
    return pendingResult(member, { ...base, thin: true });
  }

  // ONE Claude call at the caller-role's default tier (reuses the model ladder:
  // ceo/coo → Opus, department_head → Sonnet), framed through the member's lens.
  const model = TIER_MODEL[defaultTierFor(profile.role)];
  let result;
  try {
    result = await runCognitionPlan(scope, model, { lens: lensFor(member) });
  } catch (e) {
    return pendingResult(member, {
      ...base,
      ok: false,
      error: e instanceof Error ? e.message : `${member.name} planning failed.`,
    });
  }

  // Log the call regardless of parse outcome — it cost money. feature carries the
  // member key so per-officer spend is attributable in ai_usage_log.
  await logCognitionUsage(db, {
    orgId: profile.org_id,
    userId: profile.id,
    model: result.model,
    usage: result.usage,
    feature: `council:${member.key}`,
  });

  if (!result.plan) {
    return pendingResult(member, {
      ...base,
      ok: false,
      error: `${member.name}'s brief came back unreadable — nothing was filed. Try again.`,
    });
  }

  const draft = memberDraft(result.plan, scope, member);
  const { data: inserted, error } = await db
    .from("action_requests")
    .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
    .select("id")
    .single();

  if (error || !(inserted as { id?: string } | null)?.id) {
    return pendingResult(member, {
      ...base,
      ok: false,
      error: error?.message ?? "Could not file the brief into the approval queue.",
    });
  }
  const requestId = (inserted as { id: string }).id;

  await writeActionAudit(db, {
    org_id: profile.org_id,
    action_request_id: requestId,
    event: "created",
    actor_id: null,
    actor_role: "system",
    detail: {
      source: "run_council_member",
      member: member.key,
      compartment: draft.source_ref.compartment,
      grounded: scope.grounded,
      total: scope.readings.length,
      model: result.model,
    },
  });

  return pendingResult(member, { ...base, created: 1, requestId });
}

// "Run [member]" — one officer, gated to ceo/coo/department_head (the RLS
// INSERT set). Files that member's brief into approvals.
export async function runCouncilMember(memberKey: string): Promise<CouncilRunResult> {
  const profile = (await requireRole(["ceo", "coo", "department_head"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  const member = await readCouncilMember(db, memberKey);
  if (!member) {
    return {
      ok: false,
      memberKey,
      memberName: memberKey,
      created: 0,
      scopePending: false,
      thin: false,
      grounded: 0,
      total: 0,
      scopeLabel: memberKey,
      requestId: null,
      error: "That council member was not found.",
    };
  }

  const res = await runOneMember(db, profile, member);
  if (res.created > 0) {
    revalidatePath("/approvals");
    revalidatePath("/council");
  }
  return res;
}

export interface CouncilFullRunResult {
  ok: boolean;
  results: CouncilRunResult[];
  filed: number; // total briefs filed across mapped members
  error?: string;
}

// "Run Full Council" — leadership-only (ceo/coo). Runs every MAPPED member
// sequentially; each files its own brief. Unmapped officers are skipped. One
// member's failure does not abort the rest.
export async function runFullCouncil(): Promise<CouncilFullRunResult> {
  const profile = (await requireRole(["ceo", "coo"])) as unknown as Profile;
  const db = createServerSupabaseClient() as unknown as Shim;

  const members = (await readCouncilMembers(db)).filter(isMapped);
  const results: CouncilRunResult[] = [];
  for (const member of members) {
    // Sequential on purpose — one brief at a time keeps spend legible and avoids
    // hammering the model. A single failure is captured, not thrown.
    // eslint-disable-next-line no-await-in-loop
    results.push(await runOneMember(db, profile, member));
  }

  const filed = results.reduce((n, r) => n + r.created, 0);
  if (filed > 0) {
    revalidatePath("/approvals");
    revalidatePath("/council");
  }
  return { ok: true, results, filed };
}
