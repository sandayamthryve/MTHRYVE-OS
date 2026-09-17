// lib/actions/types.ts — the shared type + presentation layer for the Action &
// Approval system (the OS's hybrid AI/human safety spine).
//
// GOVERNING RULE (v1, DECISIONS.md D-005): Tony DRAFTS an action_request, a
// HUMAN approves it, then the OS EXECUTES. Nothing auto-executes — every row is
// born status='pending' and needs an approval tap. RLS on action_requests /
// action_audit enforces the tier-gated approval; this module never re-implements
// that gating, it only shapes what the UI shows and what the producer/executor
// write.
//
// The two tables aren't in the generated Database types yet, so — exactly like
// the Live and Contracts modules — callers read them through the app's cast
// shim and hand the rows to these typed helpers.

import type { BadgeTone } from "@/components/ui";

// ── Row shapes (mirror the provisioned columns) ───────────────────────────────

// Lifecycle of a request. A human decision moves pending → approved | rejected;
// the executor then moves approved → executed | failed. expired/cancelled are
// reserved for later (v1 never sets them).
//
// Governed multi-step requests (source_module='governance', e.g. the 2-approval
// permanent-delete gate) walk a SEQUENTIAL chain instead of the single 'pending'
// step: pending_coo → pending_ceo → approved → executed, with a reject at either
// stage landing on 'rejected'. These extra pending_* states live alongside the
// single-step vocabulary on the same table; the standard Approval Queue filters
// them out and the governance surface renders them (see the governance module).
export type ActionStatus =
  | "pending"
  | "pending_coo"
  | "pending_ceo"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "expired"
  | "cancelled";

// The role RLS requires to decide a row. required_role='coo' means ceo/coo only;
// 'department_head' additionally lets the owning department head approve.
export type RequiredRole = "department_head" | "coo" | "ceo";

// What the action touches — the class that decides its approval floor (PR 10 §4).
// The gate is by CLASS, not by agent: money / people / deletion / client_facing
// are leadership-only (ceo/coo); 'general' may be cleared by a department head.
// The DB (tg_action_class_gate + the class-gate CHECK) derives the class and
// floors required_role, so this type only shapes how the queue reads.
export type ActionClass = "money" | "people" | "deletion" | "client_facing" | "general";

// The four classes that require leadership. Mirrors the DB class-gate CHECK.
export const LEADERSHIP_CLASSES: ActionClass[] = ["money", "people", "deletion", "client_facing"];

export function isLeadershipClass(cls: ActionClass | null | undefined): boolean {
  return cls != null && cls !== "general";
}

// One readable fact backing Tony's reasoning (e.g. {label:'Attainment', value:'42%'}).
export interface EvidenceFact {
  label: string;
  value: string;
}

// A decision option Tony weighed, with its honest tradeoff.
export interface ActionOption {
  label: string;
  tradeoff: string;
}

// The estimated impact of acting — a plain-language summary plus, when known, the
// measurable gap the action would close.
export interface EstimatedImpact {
  summary?: string | null;
  gap_value?: number | null;
  gap_unit?: string | null;
  is_money?: boolean | null;
}

// The machine-executable instruction the executor runs on approval. v1 ships one
// type; the shape is open so later loops add their own without a schema change.
export interface ProposedAction {
  type: string;
  payload: Record<string, unknown>;
}

export interface ActionRequestRow {
  id: string;
  org_id: string;
  source_module: string;
  source_ref: Record<string, unknown> | null;
  title: string;
  problem: string | null;
  root_cause: string | null;
  evidence: EvidenceFact[] | null;
  options: ActionOption[] | null;
  recommendation: string | null;
  estimated_impact: EstimatedImpact | null;
  confidence: number | null; // 0..1
  risk_tier: number; // 0..4
  required_role: RequiredRole;
  // The class that gates approval (money/people/deletion/client_facing require
  // leadership; general may be cleared by a department head) and whether the
  // executed action can be undone. Both are DB-derived (tg_action_class_gate).
  action_class: ActionClass;
  reversible: boolean;
  proposed_action: ProposedAction | null;
  status: ActionStatus;
  created_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  executed_at: string | null;
  execution_result: Record<string, unknown> | null;
  error: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  // ── Governed multi-step approval chain (source_module='governance') ──────────
  // Live on action_requests for the sequential 2-approval gate. Null on every
  // single-step request. approval_chain is a comma-joined role order ('coo,ceo');
  // first_* records stage-1 (COO) and final_* records stage-2 (CEO) decisions.
  approval_chain?: string | null;
  first_decision?: "approved" | "rejected" | null;
  first_decided_by?: string | null;
  first_decided_at?: string | null;
  first_note?: string | null;
  final_decision?: "approved" | "rejected" | null;
  final_decided_by?: string | null;
  final_decided_at?: string | null;
  final_note?: string | null;
}

export interface ActionAuditRow {
  id: string;
  org_id: string;
  action_request_id: string | null;
  event: string; // 'created' | 'approved' | 'rejected' | 'executed' | 'failed'
  actor_id: string | null;
  actor_role: string | null; // 'system' for producer-created rows
  detail: Record<string, unknown> | null;
  created_at: string;
}

// ── Presentation ──────────────────────────────────────────────────────────────

// The risk-tier vocabulary (L0–L4). v1 has L0/autonomous OFF, so every drafted
// action is at least a human-approved tier. Labels read on the queue cards.
export const RISK_TIER_LABEL: Record<number, string> = {
  0: "L0 · Autonomous",
  1: "L1 · Low risk",
  2: "L2 · Moderate",
  3: "L3 · High risk",
  4: "L4 · Critical",
};

export function riskTierLabel(tier: number): string {
  return RISK_TIER_LABEL[tier] ?? `L${tier}`;
}

export function riskTierTone(tier: number): BadgeTone {
  if (tier >= 4) return "red";
  if (tier === 3) return "amber";
  if (tier <= 1) return "teal";
  return "violet";
}

export const STATUS_LABEL: Record<ActionStatus, string> = {
  pending: "Pending",
  pending_coo: "Awaiting COO",
  pending_ceo: "Awaiting CEO",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
};

export function statusTone(status: ActionStatus): BadgeTone {
  switch (status) {
    case "pending":
    case "pending_coo":
    case "pending_ceo":
      return "amber";
    case "approved":
      return "violet";
    case "executed":
      return "teal";
    case "rejected":
      return "muted";
    case "failed":
      return "red";
    default:
      return "muted";
  }
}

// A friendly label for where a request came from.
export const SOURCE_MODULE_LABEL: Record<string, string> = {
  reports_vs_contract: "Delivery risk · Reports vs Contract",
  bizdev: "Follow-up · BizDev lead",
  // The affiliate module carries two loops (follow-up nudges + performance
  // standards), so the label stays neutral — the card title says which one.
  affiliate: "Affiliate / KOL creator",
  // The Intelligent Warehouse carries two paths (replenish + push-to-sell); the
  // card title says which one.
  warehouse: "Warehouse · Inventory intelligence",
  // The Cash-Flow Deficit loop drafts from the finance forecast (ceo/coo only).
  finance: "Finance · Cash-flow forecast",
  // The Expense Approval workflow: each stage sign-off (finance → department →
  // management) is filed as a request here; approving it advances the expense one
  // stage via the advance_expense_stage executor. The OS never moves money.
  expense: "Finance · Expense approval",
  // The Returns/Quality loop drafts from brand & product metrics; the card title
  // says whether it's a brand or a SKU flag.
  quality: "Quality · Returns & ratings",
  // Layer-5 automation: qualified opportunities posted by automation's Opportunity
  // Engine, staged for CEO approval (approval only creates an internal lead).
  opportunity_engine: "Automation · Opportunity Engine",
  // The Opportunity Engine ranks pasted/uploaded prospects and stages HOT ones;
  // the card title names the prospect.
  opportunity: "Opportunity · Prospect ranking",
  // Tony's ACT tier: a consequential recommendation Tony proposed on a user's
  // behalf (recommendation-only — no executor; the finance loop below is the
  // money-recommendation home).
  assistant: "Tony · Recommendation",
  // Vesper's Ad Ops loop: gated TikTok/Meta pause/scale/budget changes proposed
  // from live Windsor.ai performance; the card title names the campaign.
  ad_ops: "Vesper · Ad Ops (Windsor.ai)",
  // Tony → Vesper handoff: Tony proposes a play (one of Vesper's internal
  // executor types); on approval Vesper's executor runs it and logs the result.
  tony_plan: "Vesper · Operator play",
  // Vesper's gated outreach (V2): a drafted email / Viber / DM message. Email
  // sends on approval (only if configured); Viber/DM are copy-paste only.
  outreach: "Vesper · Outreach draft",
  // Phase 3: a recommendation accepted from an AI Account Review Brief. Staged
  // for human approval; recommendation-only (no executor — nothing auto-runs).
  account_review: "Account Review · AI recommendation",
  // Automation Radar: a repeated-work pattern proposed for automation. The ONE
  // detector mines tasks org-wide; proposing files this pending request.
  // Recommendation-only in Phase 1 — nothing auto-executes.
  automation_radar: "Automation Radar · Repetition pattern",
  // The Cognition Loop: Tony reads a metric compartment against its targets and
  // emits a 3-possibility brief. Recommendation-only (proposed_action null) —
  // nothing auto-executes; the card title names the compartment scope.
  cognition_loop: "Tony · Cognition Loop",
  // The Executive AI Council: the Cognition Loop run per officer domain, framed
  // through that member's persona. Recommendation-only (proposed_action null);
  // the card title names the officer + domain, source_ref carries the member key.
  council: "Executive AI Council",
  // Governed permanent-delete: a sequential 2-approval gate (COO → CEO) that ends
  // in a service-role hard-delete via the governance executor. Anyone may request;
  // only the current-stage officer may decide. The card title names the entity.
  governance: "Governance · Permanent delete",
};

export function sourceModuleLabel(source: string): string {
  return SOURCE_MODULE_LABEL[source] ?? source;
}

// The action-class vocabulary → a short human label + plain-English "what it
// touches" line for the queue card, plus a tone. Leadership classes read hot;
// 'general' reads muted (a department head can clear it).
export const ACTION_CLASS_LABEL: Record<ActionClass, string> = {
  money: "Money",
  people: "People",
  deletion: "Deletion",
  client_facing: "Client-facing",
  general: "General",
};

export const ACTION_CLASS_IMPACT: Record<ActionClass, string> = {
  money: "Touches money — leadership (CEO / COO) only.",
  people: "Touches a person's status — leadership (CEO / COO) only.",
  deletion: "Permanently removes data — leadership (CEO / COO) only.",
  client_facing: "Sends to a client / prospect — leadership (CEO / COO) only.",
  general: "Internal / operational — a department head can approve.",
};

export function actionClassLabel(cls: ActionClass): string {
  return ACTION_CLASS_LABEL[cls] ?? cls;
}

export function actionClassImpact(cls: ActionClass): string {
  return ACTION_CLASS_IMPACT[cls] ?? "";
}

export function actionClassTone(cls: ActionClass): BadgeTone {
  switch (cls) {
    case "money":
    case "deletion":
      return "red";
    case "people":
    case "client_facing":
      return "amber";
    default:
      return "muted";
  }
}

// The audit event vocabulary → a short human label for the trail.
export const AUDIT_EVENT_LABEL: Record<string, string> = {
  created: "Drafted",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
  failed: "Execution failed",
  opportunity_received: "Opportunity received",
  record_hard_deleted: "Permanently deleted",
};

export function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABEL[event] ?? event;
}

// Confidence 0..1 → "82%" or null-safe em-dash.
export function confidencePct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${Math.round(Number(v) * 100)}%`;
}

// Whether this profile role may decide a given row, mirroring the RLS update
// policy (ceo/coo decide anything; department_head only rows they're required
// on). RLS stays the real guard — this only decides whether to render live
// buttons vs a view-only note, so we never show a control the policy would
// reject. team_member is always view-only.
export function canDecide(role: string, requiredRole: RequiredRole): boolean {
  if (role === "ceo" || role === "coo") return true;
  if (role === "department_head") return requiredRole === "department_head";
  return false;
}

// Buckets used by the queue grouping. Pending is surfaced first; everything else
// is "history".
export function isPending(status: ActionStatus): boolean {
  return status === "pending";
}
