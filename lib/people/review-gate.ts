// lib/people/review-gate.ts — the shaping layer behind the HR Review Gate.
//
// The Review Gate is the People page: instead of six scattered approval
// surfaces, every consequential agent action that touches a PERSON lands in one
// queue with a preview and an Approve / Request changes tap. Agents act; the
// operator stays in control (DECISIONS.md D-005 — Tony DRAFTS, a human
// APPROVES, the OS EXECUTES).
//
// The gate is by action_class, not by agent: 'people' is the class the DB
// derives for anything touching a person's status (tg_action_class_gate floors
// it to leadership). This module only decides what the queue SHOWS — RLS on
// action_requests stays the real authority for who may decide.

import {
  actionClassImpact,
  confidencePct,
  riskTierLabel,
  sourceModuleLabel,
  type ActionRequestRow,
} from "@/lib/actions/types";

// The agent that owns each loop, named the way the orbit names them (see
// components/home/agent-planets.tsx). The pill on a card says WHO drafted it.
const SOURCE_AGENT: Record<string, string> = {
  affiliate: "Scout",
  opportunity: "Prospector",
  opportunity_engine: "Prospector",
  outreach: "Vesper",
  ad_ops: "Vesper",
  tony_plan: "Vesper",
  warehouse: "Logi",
  quality: "Merchant",
  finance: "Ledger",
  expense: "Ledger",
  governance: "Sentinel",
  account_review: "Herald",
  reports_vs_contract: "Herald",
  bizdev: "Prospector",
  automation_radar: "Recall",
  cognition_loop: "Tony",
  council: "Tony",
  assistant: "Tony",
};

export function agentForSource(source: string): string {
  return SOURCE_AGENT[source] ?? "Tony";
}

// One card as the queue renders it — a flat, serialisable shape so the server
// component can hand it straight to the client without leaking row internals.
export interface ReviewGateItem {
  id: string;
  title: string;
  agent: string;
  source: string;
  sourceLabel: string;
  // The one-line preview of what approving would do.
  preview: string;
  // The plain-English consequence line under the preview.
  impact: string;
  riskLabel: string;
  riskTier: number;
  reversible: boolean;
  confidence: string;
  createdAt: string;
  // Whether THIS caller may decide the row (mirrors the RLS update policy). A
  // view-only card renders the note instead of the buttons.
  canDecide: boolean;
  // Recommendation-only rows carry no executor — approving acknowledges them
  // and nothing runs.
  recommendationOnly: boolean;
  // The Detailed View payload — Tony's full reasoning behind the draft.
  problem: string | null;
  rootCause: string | null;
  recommendation: string | null;
  evidence: { label: string; value: string }[];
  options: { label: string; tradeoff: string }[];
  // Dev-channel preview rows are not backed by a database row, so the card
  // resolves the tap locally and never calls the server action.
  preview_only?: boolean;
}

// The preview line: Tony's recommendation is the truest "what approving does".
// Falls back to the estimated-impact summary, then the problem statement.
function previewLine(row: ActionRequestRow): string {
  const recommendation = (row.recommendation ?? "").trim();
  if (recommendation) return recommendation;
  const summary = (row.estimated_impact?.summary ?? "").trim();
  if (summary) return summary;
  const problem = (row.problem ?? "").trim();
  return problem || "No preview was drafted for this request.";
}

// The consequence line: the measurable gap this would close when Tony quantified
// one, otherwise the class's plain-English "what it touches". Always closes with
// whether the act can be undone, because that is what an approver needs most.
function impactLine(row: ActionRequestRow): string {
  const impact = row.estimated_impact;
  const gap =
    impact?.gap_value != null
      ? `${impact.is_money ? "₱" : ""}${Number(impact.gap_value).toLocaleString("en-US")}${
          impact.is_money ? "" : ` ${impact.gap_unit ?? ""}`.trimEnd()
        }`
      : null;
  const head = gap
    ? `Impact: closes a ${gap} gap.`
    : `Impact: ${actionClassImpact(row.action_class)}`;
  return `${head} ${row.reversible ? "Reversible." : "NOT reversible — approving is final."}`;
}

export function toReviewGateItem(row: ActionRequestRow, canDecide: boolean): ReviewGateItem {
  return {
    id: row.id,
    title: row.title,
    agent: agentForSource(row.source_module),
    source: row.source_module,
    sourceLabel: sourceModuleLabel(row.source_module),
    preview: previewLine(row),
    impact: impactLine(row),
    riskLabel: riskTierLabel(row.risk_tier),
    riskTier: row.risk_tier,
    reversible: row.reversible,
    confidence: confidencePct(row.confidence),
    createdAt: row.created_at,
    canDecide,
    recommendationOnly: !row.proposed_action?.type,
    problem: row.problem,
    rootCause: row.root_cause,
    recommendation: row.recommendation,
    evidence: row.evidence ?? [],
    options: row.options ?? [],
  };
}

// The HR floor: the Review Gate on People shows what touches a PERSON. Governed
// permanent-deletes walk their own sequential COO → CEO chain and keep their
// dedicated card on /approvals, so they are held out of this single-step queue.
export function isHrGateRow(row: ActionRequestRow): boolean {
  return (
    row.status === "pending" &&
    row.action_class === "people" &&
    row.source_module !== "governance"
  );
}

// Highest risk first, then oldest-waiting first — the same ordering the Action &
// Approval Queue uses, so the two surfaces agree about what is most urgent.
export function sortForGate(rows: ActionRequestRow[]): ActionRequestRow[] {
  return [...rows].sort(
    (a, b) => b.risk_tier - a.risk_tier || a.created_at.localeCompare(b.created_at)
  );
}

// The same ordering applied to already-shaped cards, so the devchannel preview
// rows queue up exactly the way live ones do.
export function sortItems(items: ReviewGateItem[]): ReviewGateItem[] {
  return [...items].sort(
    (a, b) => b.riskTier - a.riskTier || a.createdAt.localeCompare(b.createdAt)
  );
}
