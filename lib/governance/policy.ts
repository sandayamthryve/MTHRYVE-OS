// lib/governance/policy.ts — the CONSULT HELPER for the Policy Registry.
//
// checkPolicy(action, context) is the single place consequential server actions
// ask the centralized rulebook "may I do this?" BEFORE acting. It reads the
// governance rules from public.policy_registry (the ONE editable source, seeded
// by migration 20260717000000) and returns allow | deny | needs_approval + a
// human reason.
//
// IMPORTANT — this does NOT replace enforcement. RLS, the money-gate, and the
// approval spine still ENFORCE independently; this helper is the layer that
// READS the rules those gates encode, so a threshold or rule can change in the
// Governance screen and behaviour changes with no code edit. Because the real
// gates remain, an infra read error here fails OPEN (returns allow) rather than
// breaking the app — it never becomes a second, brittle point of failure.
//
// policy_registry isn't in the generated Database types yet, so — like the rest
// of the action spine — we read it through the app's cast shim.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { writeActionAudit } from "@/lib/actions/audit";

type Shim = { from: (t: string) => any };

// The rulebook categories (mirror the CHECK constraint on policy_registry).
export type PolicyCategory =
  | "approval"
  | "spend"
  | "tool_permission"
  | "data_access"
  | "audit"
  | "escalation"
  | "confidence"
  | "compliance";

export type PolicyDecision = "allow" | "deny" | "needs_approval";

// One rulebook row.
export interface PolicyRow {
  id: string;
  org_id: string;
  key: string;
  category: PolicyCategory;
  scope: string | null;
  rule: Record<string, unknown>;
  description: string | null;
  active: boolean;
}

// The consequential actions the OS gates. Each maps to the policy key that
// governs it (see the seed in the migration). Add a case here + a row in the
// registry to gate a new action — no other code changes.
export type PolicyAction =
  | "spend" // moving money / ad spend
  | "outbound_send" // email / DM / any outbound message
  | "ai_execute" // executing an approved action_request
  | "publish" // publishing client content
  | "finance_read" // reading finance / cash data
  | "ai_recommend" // surfacing an AI recommendation
  | "high_risk" // acting on a high-risk decision
  | "automation_service_role"; // GitHub Actions asking for the service-role key

const ACTION_POLICY_KEY: Record<PolicyAction, string> = {
  spend: "ai_spend_requires_approval",
  outbound_send: "consequential_requires_approval",
  ai_execute: "consequential_requires_approval",
  publish: "ai_no_direct_publish",
  finance_read: "finance_leadership_only",
  ai_recommend: "recommendations_carry_confidence",
  high_risk: "high_risk_leadership_escalation",
  automation_service_role: "automation_no_service_role_key",
};

export interface PolicyContext {
  orgId: string;
  // Optional Supabase client to read/audit through. If omitted, the service-role
  // client is used (safe: reading org-scoped rules + writing the audit trail).
  // Pass the caller's RLS client when one is already in hand (e.g. finance read).
  db?: Shim;
  actorId?: string | null;
  actorRole?: string | null; // 'ceo' | 'coo' | 'department_head' | 'team_member' | 'system'
  isAi?: boolean; // the actor is an AI agent, not a human
  approved?: boolean; // a human approval has already been obtained for this action
  amountPhp?: number | null; // pesos, for spend checks
  confidence?: number | null; // 0..1, for confidence checks
  riskTier?: number | null; // 0..4, for escalation checks
  actionRequestId?: string | null; // link the audit row to a request when there is one
  detail?: Record<string, unknown> | null;
  audit?: boolean; // write denials/approvals to action_audit (default true)
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  policyKey: string | null;
  category: PolicyCategory | null;
  active: boolean; // whether a governing (active) policy was found
}

// Read the governing policy row for an action, or null if absent/inactive.
async function loadPolicy(
  db: Shim,
  orgId: string,
  key: string
): Promise<PolicyRow | null> {
  try {
    const { data } = await db
      .from("policy_registry")
      .select("id, org_id, key, category, scope, rule, description, active")
      .eq("org_id", orgId)
      .eq("key", key)
      .maybeSingle();
    return (data as PolicyRow | null) ?? null;
  } catch {
    return null;
  }
}

function ruleNum(rule: Record<string, unknown>, k: string, fallback: number): number {
  const v = rule[k];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function ruleRoles(rule: Record<string, unknown>, fallback: string[]): string[] {
  const v = rule["allowed_roles"];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;
}

// Evaluate one action against its governing rule. Pure — no I/O.
function evaluate(action: PolicyAction, policy: PolicyRow, ctx: PolicyContext): PolicyResult {
  const rule = policy.rule ?? {};
  const base = { policyKey: policy.key, category: policy.category, active: true } as const;

  switch (action) {
    case "spend": {
      const threshold = ruleNum(rule, "threshold_php", 0);
      const amount = ctx.amountPhp ?? null;
      if (ctx.approved) {
        return { ...base, decision: "allow", reason: `Spend approved by a human (₱ threshold ${threshold}).` };
      }
      if (amount != null && amount <= threshold) {
        return { ...base, decision: "allow", reason: `₱${amount} is within the no-approval threshold of ₱${threshold}.` };
      }
      return {
        ...base,
        decision: "needs_approval",
        reason: `AI actions spend no money without approval${amount != null ? ` (₱${amount} exceeds ₱${threshold})` : ""}.`,
      };
    }

    case "outbound_send":
    case "ai_execute": {
      if (ctx.approved) {
        return { ...base, decision: "allow", reason: "Consequential action has a human approval." };
      }
      return {
        ...base,
        decision: "needs_approval",
        reason: "Outbound / consequential actions require human approval before executing.",
      };
    }

    case "publish": {
      // AI can never publish client content directly; a human may.
      if (ctx.isAi) {
        return { ...base, decision: "deny", reason: "AI cannot publish client content directly — a human publishes." };
      }
      return { ...base, decision: "allow", reason: "Human-initiated publish is permitted." };
    }

    case "finance_read": {
      const allowed = ruleRoles(rule, ["ceo", "coo"]);
      const role = ctx.actorRole ?? "";
      if (allowed.includes(role)) {
        return { ...base, decision: "allow", reason: `Finance data is readable by ${allowed.join("/")}.` };
      }
      return {
        ...base,
        decision: "deny",
        reason: `Finance data is restricted to ${allowed.join("/")}; role "${role || "unknown"}" may not read it.`,
      };
    }

    case "ai_recommend": {
      const min = ruleNum(rule, "min_confidence", 0.5);
      const c = ctx.confidence ?? null;
      if (c != null && c < min) {
        return {
          ...base,
          decision: "needs_approval",
          reason: `Confidence ${(c * 100).toFixed(0)}% is below ${(min * 100).toFixed(0)}% — escalate for leadership review.`,
        };
      }
      return { ...base, decision: "allow", reason: "Recommendation meets the confidence floor." };
    }

    case "high_risk": {
      const threshold = ruleNum(rule, "risk_tier_threshold", 3);
      const tier = ctx.riskTier ?? 0;
      if (tier >= threshold) {
        return {
          ...base,
          decision: "needs_approval",
          reason: `Risk tier ${tier} at/above ${threshold} — requires leadership escalation.`,
        };
      }
      return { ...base, decision: "allow", reason: `Risk tier ${tier} is below the escalation threshold ${threshold}.` };
    }

    case "automation_service_role": {
      return { ...base, decision: "deny", reason: "GitHub Actions never receives the service-role key." };
    }

    default:
      return { policyKey: policy.key, category: policy.category, active: true, decision: "allow", reason: "No rule matched." };
  }
}

// The consult entry point. Reads the governing rule for `action`, evaluates it
// against `context`, records denials/approvals to action_audit, and returns the
// decision. Never throws.
export async function checkPolicy(action: PolicyAction, context: PolicyContext): Promise<PolicyResult> {
  const key = ACTION_POLICY_KEY[action];
  const db: Shim = context.db ?? (createServiceRoleClient() as unknown as Shim);

  const policy = await loadPolicy(db, context.orgId, key);

  // No governing policy, or leadership has deactivated it → the registry says
  // this action is not gated here. The underlying enforcement (RLS / approval
  // spine) still stands; this layer simply has no rule to apply.
  if (!policy || policy.active === false) {
    return {
      decision: "allow",
      reason: policy ? `Policy "${key}" is inactive.` : `No policy "${key}" configured.`,
      policyKey: policy ? key : null,
      category: policy?.category ?? null,
      active: false,
    };
  }

  const result = evaluate(action, policy, context);

  // Record denials + approvals to the shared action_audit trail. Allows that
  // represent a real approval are worth recording; routine passes are not, to
  // keep the trail signal-rich.
  const shouldAudit =
    context.audit !== false &&
    (result.decision === "deny" ||
      result.decision === "needs_approval" ||
      (result.decision === "allow" && context.approved === true));

  if (shouldAudit) {
    const event =
      result.decision === "deny"
        ? ("policy_denied" as const)
        : result.decision === "needs_approval"
          ? ("policy_needs_approval" as const)
          : ("policy_allowed" as const);
    await writeActionAudit(db, {
      org_id: context.orgId,
      action_request_id: context.actionRequestId ?? null,
      event,
      actor_id: context.actorId ?? null,
      actor_role: context.actorRole ?? (context.isAi ? "ai" : "system"),
      detail: {
        action,
        policy_key: result.policyKey,
        category: result.category,
        decision: result.decision,
        reason: result.reason,
        ...(context.detail ?? {}),
      },
    });
  }

  return result;
}
