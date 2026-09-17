// lib/security/tool-tiers.ts — least-privilege tool tiers for the agents
// (PASTE 4.3 Part B).
//
// Every tool an agent (Tony / Vesper) can call is classified into ONE tier:
//   • read     — RLS-scoped queries only; can NEVER write, send, or spend.
//   • write    — internal, reversible, self-scoped writes done on the caller's
//                own RLS client (e.g. update your own task). No approval needed
//                because RLS already limits it to what the user could do by hand.
//   • approval — consequential/outbound/spend actions. These are NOT executed by
//                the agent; the tool only FILES a pending action_request that a
//                human approves, and the shared executor runs it (gated again by
//                checkPolicy). This is where "outbound / spend route through
//                approval" is enforced.
//
// This module is defense-in-depth on top of the existing controls (role-filtered
// tool lists, RLS, checkPolicy in the executor). It gives one authoritative map
// of "which tier is this tool" + a runtime guard the dispatch loop calls before
// running any tool, and it lets leadership DENY a tool org-wide from the
// policy_registry (category='tool_permission') with no code change.

import type { UserRole } from "@/types/database";

export type ToolTier = "read" | "write" | "approval";

// The authoritative classification. Any tool not listed defaults to the strictest
// posture (treated as "approval": it must justify itself, never silently run as a
// read). Keeping the map explicit means adding a tool without classifying it
// fails safe rather than open.
export const TOOL_TIERS: Record<string, ToolTier> = {
  // ── Care READ tier (lib/care/tools.ts) ─────────────────────────────────────
  get_my_care_summary: "read",
  get_team_care_pulse: "read",
  get_probation_care_context: "read",
  search_hr_knowledge: "read",
  // ── Atlas READ tier (lib/atlas/tools.ts) ───────────────────────────────────
  search_atlas_knowledge: "read",
  recall_atlas_memory: "read",
  get_graph_snapshot: "read",
  list_capabilities: "read",
  // ── Oracle READ tier (lib/oracle/tools.ts) ─────────────────────────────────
  get_cashflow_forecast: "read",
  get_budget_health: "read",
  search_finance_knowledge: "read",
  // ── Herald READ tier (lib/herald/tools.ts) ─────────────────────────────────
  list_outreach_queue: "read",
  get_outreach_target: "read",
  search_outreach_knowledge: "read",
  draft_herald_message: "read",
  // ── Prospector READ tier (lib/prospector/tools.ts) ─────────────────────────
  list_prospect_queue: "read",
  get_prospect_context: "read",
  find_prospects: "read",
  search_prospect_knowledge: "read",

  // ── Tony READ tier (lib/assistant/read.ts + tools.ts) ──────────────────────
  get_org_pulse: "read",
  get_brand_status: "read",
  get_department_plan: "read",
  list_my_work: "read",
  get_finance_snapshot: "read",
  list_automation_opportunities: "read",
  search_knowledge: "read",
  recall_memory: "read",
  list_brands: "read",
  list_departments: "read",
  get_returns_analysis: "read",
  get_payroll_summary: "read",
  get_pending_approvals: "read",
  list_projects: "read",
  search_capabilities: "read",
  // navigate is a client-side UI action, not a data write.
  navigate: "read",
  // ── Vesper READ tier (lib/vesper/persona.ts) ───────────────────────────────
  preview_scoreboard: "read",

  // ── Care WRITE tier — self-scoped, reversible, RLS-limited ─────────────────
  log_wellbeing_pulse: "write",

  // ── Tony WRITE tier — self-scoped, reversible, RLS-limited ─────────────────
  update_my_task_status: "write",
  add_content_item: "write",
  pin_memory_note: "write",
  create_mission_tasks: "write",

  // ── APPROVAL tier — files a pending action_request; a human approves ───────
  propose_action: "approval",
  propose_check_in: "approval",
  propose_atlas_capture: "approval",
  propose_oracle_action: "approval",
  propose_herald_send: "approval",
  propose_prospect_task: "approval",
  // Vesper's one write path: files a pending play into the Approval Queue.
  propose_play: "approval",
};

// Roles allowed to use each tier. Reads + self-scoped writes are open to every
// authenticated role (RLS still scopes the data). Filing an approval request is
// leadership + department heads only — mirrors the action_requests RLS and the
// existing buildActTools / buildVesperTools role gates.
const TIER_ALLOWED_ROLES: Record<ToolTier, ReadonlySet<UserRole>> = {
  read: new Set<UserRole>(["ceo", "coo", "department_head", "team_member"]),
  write: new Set<UserRole>(["ceo", "coo", "department_head", "team_member"]),
  approval: new Set<UserRole>(["ceo", "coo", "department_head"]),
};

export function tierOf(toolName: string): ToolTier {
  return TOOL_TIERS[toolName] ?? "approval";
}

/** A read-tier tool must be one that only reads — used to assert no write leaks. */
export function isReadTier(toolName: string): boolean {
  return tierOf(toolName) === "read";
}

export interface ToolGuardResult {
  ok: boolean;
  tier: ToolTier;
  reason?: string;
}

/**
 * The runtime gate the dispatch loop calls before running a tool.
 *   • denies a tool leadership has switched off org-wide (policy_registry), and
 *   • denies a tool whose tier the caller's role may not use.
 * `deniedTools` is the set of tool names denied by an active tool_permission
 * policy (see loadToolPolicyDenies). Everything else is allowed — RLS + the
 * approval spine remain the hard enforcement for what a WRITE/APPROVAL tool can
 * actually do.
 */
export function guardToolCall(
  toolName: string,
  role: UserRole,
  deniedTools?: ReadonlySet<string>
): ToolGuardResult {
  const tier = tierOf(toolName);

  if (deniedTools && deniedTools.has(toolName)) {
    return {
      ok: false,
      tier,
      reason: `Tool "${toolName}" is disabled by an org policy (policy_registry / tool_permission). Tell the user this action is turned off by governance.`,
    };
  }

  if (!TIER_ALLOWED_ROLES[tier].has(role)) {
    return {
      ok: false,
      tier,
      reason:
        tier === "approval"
          ? `Filing this action requires a leadership or department-head role. Route it to their pod lead / leadership instead — do not execute it.`
          : `Your role may not use "${toolName}".`,
    };
  }

  return { ok: true, tier };
}

// The policy_registry shim (same cast pattern the rest of the OS uses — the
// table isn't in the generated Database types).
type PolicyShim = { from: (t: string) => any };

/**
 * Load the set of tool names denied by an ACTIVE tool_permission policy for this
 * org. Convention: a policy row with category='tool_permission' whose
 * rule.deny_tools is a string[] denies exactly those tool names. Best-effort —
 * any read error returns an empty set (RLS + approval still enforce), so this can
 * only ever ADD guardrails, never remove them.
 */
export async function loadToolPolicyDenies(
  db: unknown,
  orgId: string
): Promise<Set<string>> {
  const denied = new Set<string>();
  try {
    const client = db as PolicyShim;
    const { data } = await client
      .from("policy_registry")
      .select("rule, active, category")
      .eq("org_id", orgId)
      .eq("category", "tool_permission")
      .eq("active", true);
    const rows = (data ?? []) as Array<{ rule?: { deny_tools?: unknown } }>;
    for (const row of rows) {
      const list = row?.rule?.deny_tools;
      if (Array.isArray(list)) {
        for (const t of list) if (typeof t === "string") denied.add(t);
      }
    }
  } catch {
    // best-effort — governance is a tightening layer, never a point of failure.
  }
  return denied;
}
