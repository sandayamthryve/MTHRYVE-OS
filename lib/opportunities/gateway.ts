// lib/opportunities/gateway.ts — THE GATEWAY between the Opportunity Engine's
// verdict and the human approval queue.
//
// GOVERNING RULE (DECISIONS.md D-005): nothing auto-executes and nothing reaches
// a prospect. When the engine ranks a prospect HOT, the gateway STAGES it as a
// PENDING action_request carrying the engine's reasoning — exactly like the
// follow-up and warehouse loops stage theirs. A human still has to approve it in
// the queue before the OS opens even an internal task; approving does NOT contact
// anyone (see the create_opportunity_task executor).
//
// Idempotent + non-duplicating on two fronts:
//   • If the engine's OWN gateway already staged a result (it reported staged /
//     an action_request id), we DON'T stage it again — we only surface it.
//   • We skip any candidate that already has an OPEN (pending/approved)
//     opportunity request this scan, so re-submitting the same list never
//     double-stages.
//
// The action_requests / action_audit tables aren't in the generated Database
// types, so they're reached through the app's cast shim, as elsewhere.

import { pesoOrDash } from "@/lib/metrics/format";
import { writeActionAudit } from "@/lib/actions/audit";
import type {
  EvidenceFact,
  ActionOption,
  EstimatedImpact,
  ProposedAction,
  RequiredRole,
} from "@/lib/actions/types";
import type { OpportunityCandidate } from "./csv";
import { candidateKey, type OpportunityCriteria, type RankedOpportunity } from "./engine";

type Shim = { from: (t: string) => any };
type Profile = { id: string; org_id: string; role: string };

// The drafted action_request payload for one HOT opportunity (org/user columns
// stamped by the caller).
export interface OpportunityDraft {
  source_module: "opportunity";
  source_ref: Record<string, unknown>;
  title: string;
  problem: string;
  root_cause: string;
  evidence: EvidenceFact[];
  options: ActionOption[];
  recommendation: string;
  estimated_impact: EstimatedImpact;
  confidence: number;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: ProposedAction;
}

// Human-readable signal labels, only for signals we actually KNOW are true — an
// unknown/false signal is simply omitted rather than asserted.
function knownSignals(c: OpportunityCandidate | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.sells_online === true) out.push("sells online");
  if (c.has_tiktok_shop === true) out.push("has a TikTok Shop");
  if (c.gmv_declining === true) out.push("GMV declining");
  if (c.runs_ads === true) out.push("runs ads");
  return out;
}

// Build the pending action_request draft for one HOT ranked opportunity. Pure —
// it fabricates nothing: every evidence fact comes from the engine's score/reason
// or a candidate field that actually exists.
export function buildOpportunityDraft(
  op: RankedOpportunity,
  criteria: OpportunityCriteria
): OpportunityDraft {
  const c = op.candidate;
  const signals = knownSignals(c);
  const category = c?.category ?? null;

  const evidence: EvidenceFact[] = [
    { label: "Engine tier", value: op.tier },
    { label: "Score", value: `${op.score}/100` },
  ];
  if (category) evidence.push({ label: "Category", value: category });
  if (c?.monthly_revenue != null)
    evidence.push({ label: "Monthly revenue", value: pesoOrDash(c.monthly_revenue) });
  if (signals.length > 0) evidence.push({ label: "Signals", value: signals.join(", ") });

  const signalLine = signals.length > 0 ? ` It ${signals.join(", ")}.` : "";

  return {
    source_module: "opportunity",
    source_ref: {
      candidate_key: candidateKey(op.name),
      source: "opportunity_engine",
      tier: op.tier,
      score: op.score,
    },
    title: `Opportunity: ${op.name}${category ? ` (${category})` : ""}`,
    problem:
      `The Opportunity Engine ranked ${op.name} HOT (score ${op.score}/100) against your criteria.` +
      signalLine +
      ` A timely, human-approved outreach plan could turn this prospect into pipeline before a competitor moves.`,
    root_cause: op.reason,
    evidence,
    options: [
      {
        label: "Open a BizDev qualification task",
        tradeoff:
          "Puts the prospect in front of the BizDev owner to research and qualify now — nothing is sent to the prospect until a human decides to.",
      },
      {
        label: "Hold for the next review",
        tradeoff:
          "Waits until the next pipeline review — fine if capacity is tight, but a hot signal can cool while it sits.",
      },
      {
        label: "Dismiss",
        tradeoff: "Rejects the opportunity — only right if it clearly isn't a fit.",
      },
    ],
    recommendation:
      `Approve to open an internal qualification task for the BizDev team to research ${op.name} and decide the next move. ` +
      `No message reaches the prospect on approval — this only stages the work.`,
    estimated_impact: {
      summary: `A qualified HOT prospect entering the BizDev pipeline — ${op.reason}`,
      gap_value: c?.monthly_revenue != null ? Number(c.monthly_revenue) : null,
      gap_unit: c?.monthly_revenue != null ? "prospect monthly revenue" : null,
      is_money: c?.monthly_revenue != null,
    },
    // A ranked opportunity is an informed lead, not a certainty — mirror the
    // engine's own confidence (score) rather than inventing one.
    confidence: Math.max(0.5, Math.min(0.95, op.score / 100)),
    risk_tier: 2,
    required_role: "department_head",
    proposed_action: {
      type: "create_opportunity_task",
      payload: {
        candidate_name: op.name,
        category,
        monthly_revenue: c?.monthly_revenue ?? null,
        tier: op.tier,
        score: op.score,
        reason: op.reason,
        signals,
      },
    },
  };
}

export interface StageResult {
  hot: number; // HOT results seen this call
  staged: number; // new pending action_requests we created
  alreadyStaged: number; // HOT results the engine's gateway had already staged
  skipped: number; // HOT results skipped because an open request already existed
}

// Stage the HOT results as pending action_requests for human approval. Only HOT
// tiers are staged; WARM/COLD are display-only. Skips results the engine already
// staged and candidates that already carry an open opportunity request. Writes a
// system 'created' audit row per new draft. Returns a tally for the panel.
export async function stageHotOpportunities(
  db: Shim,
  profile: Profile,
  criteria: OpportunityCriteria,
  results: RankedOpportunity[]
): Promise<StageResult> {
  const hot = results.filter((r) => r.tier === "HOT");
  const tally: StageResult = {
    hot: hot.length,
    staged: 0,
    alreadyStaged: 0,
    skipped: 0,
  };
  if (hot.length === 0) return tally;

  // Existing OPEN opportunity requests → their candidate keys, so we never
  // double-stage the same prospect.
  const { data: openRows } = await db
    .from("action_requests")
    .select("source_ref, source_module, status")
    .eq("source_module", "opportunity")
    .in("status", ["pending", "approved"]);
  const openKeys = new Set<string>();
  for (const r of (openRows ?? []) as Array<{ source_ref: { candidate_key?: string } | null }>) {
    const k = r.source_ref?.candidate_key;
    if (k) openKeys.add(k);
  }

  for (const op of hot) {
    // The engine's own gateway already staged this one — surface it, don't dupe.
    if (op.staged) {
      tally.alreadyStaged += 1;
      continue;
    }
    const key = candidateKey(op.name);
    if (openKeys.has(key)) {
      tally.skipped += 1;
      continue;
    }
    const draft = buildOpportunityDraft(op, criteria);
    const { data: inserted, error } = await db
      .from("action_requests")
      .insert({ org_id: profile.org_id, created_by: profile.id, status: "pending", ...draft })
      .select("id")
      .single();
    if (error || !(inserted as { id?: string } | null)?.id) continue;
    const id = (inserted as { id: string }).id;
    await writeActionAudit(db, {
      org_id: profile.org_id,
      action_request_id: id,
      event: "created",
      actor_id: null,
      actor_role: "system",
      detail: { source: "opportunity_engine", candidate_key: key, tier: op.tier, score: op.score },
    });
    openKeys.add(key); // guard against dupes within the same submission
    tally.staged += 1;
  }

  return tally;
}
