// lib/vesper/plays.ts — the registry of Vesper's internal "plays".
//
// Vesper is the OS's Operator agent: where Tony PLANS (proposes), Vesper
// EXECUTES (acts + logs). A "play" is one machine-executable operation Vesper
// can run — and each is dispatched through the SAME action_requests spine and
// executor pattern as create_lead (see lib/actions/executor.ts). A play type is
// the `proposed_action.type` on an action_request whose `source_module` is
// 'tony_plan'; on approval the executor runs the matching runner in
// lib/vesper/executors.ts and writes an action_audit row.
//
// GOVERNING RULES (v1, non-negotiable — mirror AI_AGENTS.md / DECISIONS.md D-005):
//   • Internal only. Every play reads live data and, at most, writes fully
//     reversible INTERNAL rows (e.g. content_items ideas). NONE reach anything
//     external: no email/DM/post, no ad spend, no money movement, no new keys.
//   • Approval-gated by default. A play is filed as a PENDING action_request and
//     a human approves before the executor runs. Low-risk plays MAY be
//     configured to auto-run (AUTO_RUN_LOW_RISK), but the approval path stays
//     intact and the default is gated.

import type { RequiredRole } from "@/lib/actions/types";

// The six internal executor types, in cockpit order.
export type VesperPlayType =
  | "generate_scripts"
  | "forecast_restock"
  | "next_best_product"
  | "match_creators"
  | "analyze_content_performance"
  | "compile_scoreboard";

export const VESPER_PLAY_TYPES: VesperPlayType[] = [
  "generate_scripts",
  "forecast_restock",
  "next_best_product",
  "match_creators",
  "analyze_content_performance",
  "compile_scoreboard",
];

export interface VesperPlaySpec {
  type: VesperPlayType;
  label: string;
  // Operator-facing, one line: what running this play does.
  description: string;
  // Which engine the play reuses — shown in the UI so it's clear nothing new is
  // being invented; Vesper orchestrates existing infra.
  engine: string;
  // Whether the play WRITES any internal row (vs. a pure read that only returns
  // a result). generate_scripts stages content_items ideas; the rest are reads.
  writes: boolean;
  // Risk tier for the drafted action_request (0..4). All Vesper plays are
  // low-risk internal operations, so 1.
  riskTier: number;
  // The role RLS requires to DECIDE the request. Leadership (ceo/coo) can always
  // decide; department_head can decide its own required rows.
  requiredRole: RequiredRole;
  // Eligible to auto-run when AUTO_RUN_LOW_RISK is on (read-only analytics).
  lowRisk: boolean;
}

export const VESPER_PLAYS: Record<VesperPlayType, VesperPlaySpec> = {
  generate_scripts: {
    type: "generate_scripts",
    label: "Generate scripts",
    description:
      "Draft script briefs per SKU × pillar × format through the content engine and stage them as content ideas.",
    engine: "Content engine (lib/content)",
    writes: true,
    riskTier: 1,
    requiredRole: "department_head",
    lowRisk: false,
  },
  forecast_restock: {
    type: "forecast_restock",
    label: "Forecast restock",
    description:
      "Run the warehouse velocity engine to surface which SKUs need replenishing and a suggested quantity.",
    engine: "Warehouse velocity engine (lib/warehouse)",
    writes: false,
    riskTier: 1,
    requiredRole: "department_head",
    lowRisk: true,
  },
  next_best_product: {
    type: "next_best_product",
    label: "Next best product",
    description:
      "Read live sessions + TikTok Shop momentum to rank which products to push next.",
    engine: "Live + TikTok Shop readers (lib/tiktok, live_sessions)",
    writes: false,
    riskTier: 1,
    requiredRole: "department_head",
    lowRisk: true,
  },
  match_creators: {
    type: "match_creators",
    label: "Match creators",
    description:
      "Rank creators from the roster (creators + tiers) against a brand or campaign.",
    engine: "Creator roster (creators + creator_tiers)",
    writes: false,
    riskTier: 1,
    requiredRole: "department_head",
    lowRisk: true,
  },
  analyze_content_performance: {
    type: "analyze_content_performance",
    label: "Analyze content performance",
    description:
      "Read content_performance to surface what converts by format and category.",
    engine: "Content performance (content_performance)",
    writes: false,
    riskTier: 1,
    requiredRole: "department_head",
    lowRisk: true,
  },
  compile_scoreboard: {
    type: "compile_scoreboard",
    label: "Compile scoreboard",
    description:
      "Assemble the Growth Scoreboard (per pod + org-wide KPIs) from live data.",
    engine: "GMV engine + pods (lib/metrics, lib/vesper/scoreboard)",
    writes: false,
    riskTier: 1,
    requiredRole: "department_head",
    lowRisk: true,
  },
};

// The source_module Vesper plays carry on the action_requests spine. One label,
// so the Approval Queue and audit trail render Tony→Vesper handoffs consistently.
export const VESPER_SOURCE_MODULE = "tony_plan";

// Master switch for auto-running low-risk plays. DEFAULT OFF — every play is
// approval-gated unless leadership turns this on, and even then only reads
// (lowRisk) auto-run; a play that writes always waits for a human. Keeping this
// a single constant (not per-call) means the "default to gated" rule is one
// obvious line, and the approval path is never removed — auto-run just files the
// request and immediately runs the same executor.
export const AUTO_RUN_LOW_RISK = false;

export function isVesperPlayType(v: unknown): v is VesperPlayType {
  return typeof v === "string" && (VESPER_PLAY_TYPES as string[]).includes(v);
}

export function vesperPlay(type: VesperPlayType): VesperPlaySpec {
  return VESPER_PLAYS[type];
}

// Whether a given play should auto-run on file (low-risk + master switch on).
// A writing play never auto-runs regardless of the switch.
export function shouldAutoRun(type: VesperPlayType): boolean {
  const spec = VESPER_PLAYS[type];
  return AUTO_RUN_LOW_RISK && spec.lowRisk && !spec.writes;
}
