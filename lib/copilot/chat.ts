// lib/copilot/chat.ts — the BRAIN of the Copilot Fleet.
//
// A copilot is a council_members row made CONVERSATIONAL: the same persona +
// domain + compartment_codes, now backing a persistent, grounded chat instead of
// a one-shot brief. This module owns the pieces the /api/copilot/[key]/chat route
// composes — it reuses the existing spine end to end and adds no parallel engine:
//   • grounding text  → lib/cognition scope read (READ ONLY, honest "—")
//   • the model call   → the same ANTHROPIC_API_KEY / Messages endpoint, but with
//                        the full ai_messages thread (multi-turn), Sonnet-backed
//   • the action path  → ONE action_requests row (proposed_action null), gated
//
// It NEVER writes. The route stamps org_id / created_by / status and inserts, and
// nothing here executes anything — every real action becomes a pending approval.

import { TIER_MODEL } from "@/lib/ai/models";
import type { AnthropicUsage } from "@/lib/briefings/anthropic";
import { UNTRUSTED_DATA_SYSTEM_PROMPT, wrapUntrusted } from "@/lib/security/untrusted";
import type { RequiredRole } from "@/lib/actions/types";
import type { CouncilMember } from "@/lib/council/members";
import type { CompartmentScope } from "@/lib/cognition/types";
import type { KnowledgeHit } from "@/lib/knowledge/search";

// Copilots are Sonnet-backed (the task's spec): a domain expert you talk to,
// mid-tier by default. One model id, resolved from the shared ladder.
export const COPILOT_MODEL = TIER_MODEL.standard; // claude-sonnet-5

// Anthropic message shape for a multi-turn call (mirrors the assistant route).
export type CopilotMessage = { role: "user" | "assistant"; content: string };

// ── Grounding text ────────────────────────────────────────────────────────────

// The live-metrics block, built from the Cognition Loop's own READ half. Each
// reading already carries a deterministic, honest status phrase ("4.55% vs
// target 5% — …", or "No entry on record — reads —."), so this only frames them.
// A copilot whose compartments aren't wired (cto/bi/hr) grounds on NOTHING and is
// told to say so — never to invent numbers.
export function buildScopeText(scope: CompartmentScope, member: CouncilMember): string {
  if (scope.readings.length === 0) {
    return [
      `No metric compartments are wired to ${member.name} yet, so you have no live numbers to`,
      "ground on. If the user asks about metrics, say plainly that this domain's numbers aren't",
      "wired up yet — never invent a value.",
    ].join(" ");
  }
  const lines: string[] = [];
  lines.push(`Compartment scope: ${scope.label}`);
  lines.push(
    `${scope.grounded} of ${scope.readings.length} metrics have a real entry; the rest read "—" and must not be treated as known.`
  );
  lines.push("");
  for (const r of scope.readings) {
    lines.push(`• ${r.label}: ${r.status}`);
  }
  return lines.join("\n");
}

// ── System prompt ─────────────────────────────────────────────────────────────

// The action-proposal protocol. A copilot can't execute anything; to make a real
// thing happen it appends ONE fenced block the route parses out (and strips from
// the visible reply) before filing a gated action_requests row.
const ACTION_PROTOCOL = [
  "=== What you can and cannot do ===",
  "You CANNOT execute anything — you never move money, send messages, place orders, or write",
  "metrics. To make something happen you PROPOSE ONE concrete action, and a human approves it.",
  "",
  "When (and ONLY when) you want to propose one specific, concrete action, append to the very end",
  "of your reply a fenced block EXACTLY like this:",
  "```action",
  '{"title": "<short action title>", "summary": "<what should happen and why, 1-2 sentences>"}',
  "```",
  "Write your normal chat reply above it and do NOT mention the block. Include it only for a real,",
  "specific, actionable proposal — never for general discussion, analysis, or a question back to",
  "the user. At most one block per reply.",
].join("\n");

export function buildCopilotSystemPrompt(opts: {
  member: CouncilMember;
  scopeText: string;
  hits: KnowledgeHit[];
}): string {
  const { member, scopeText, hits } = opts;

  const identity = [
    `You are ${member.name}, ${member.title} — a persistent AI copilot inside a Philippine TikTok`,
    "Shop & Shopee agency OS. You are a domain expert the user can talk to that already knows this",
    "domain's live numbers.",
    `Domain: ${member.domain}`,
    `Operating persona: ${member.persona}`,
    member.extra_scope ? `Extra scope: ${member.extra_scope}` : "",
    "Speak in that voice — concise, specific, and grounded. Keep replies tight.",
  ]
    .filter(Boolean)
    .join("\n");

  const honesty = [
    "=== Honesty (HARD RULES) ===",
    "1. Ground every number in the live metrics below. NEVER invent a value, target, cause, or",
    '   trend. A metric that reads "—" has NO entry — say the data isn\'t there rather than guess.',
    "2. Cite the metric you're reasoning from when you state a number.",
    "3. If this domain has no metrics wired yet, say so plainly instead of fabricating a picture.",
  ].join("\n");

  const grounding = ["=== Live metrics (grounding — READ ONLY) ===", scopeText].join("\n");

  // RAG context is untrusted (uploaded SOPs, docs, other users' content). Frame it
  // as DATA behind the instruction-source boundary so an embedded instruction is
  // surfaced, never obeyed. The boundary rule sits above the data.
  const ragBlock = hits.length
    ? [
        "=== Relevant project docs (retrieved — cite the title) ===",
        wrapUntrusted(
          hits
            .map((h, i) => `[${i + 1}] ${h.title}\n${h.content}`)
            .join("\n\n"),
          { source: "knowledge base" }
        ),
      ].join("\n")
    : "";

  return [
    identity,
    honesty,
    UNTRUSTED_DATA_SYSTEM_PROMPT,
    grounding,
    ragBlock,
    ACTION_PROTOCOL,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── The model call ────────────────────────────────────────────────────────────

// ONE Anthropic call over the full thread — the same key/endpoint as every other
// AI surface, but multi-turn (the ai_messages history) so the copilot has memory.
// Returns the concatenated text + usage (usage is logged to ai_usage_log by the
// route regardless of parse outcome). Throws only on an API/transport error.
export async function callCopilot(opts: {
  model: string;
  system: string;
  messages: CopilotMessage[];
  maxTokens: number;
}): Promise<{ text: string; usage: AnthropicUsage }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  const payload = (await res.json()) as {
    content?: { type: string; text: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(payload?.error?.message ?? "copilot generation failed");
  const text = (payload.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const usage: AnthropicUsage = {
    inputTokens: Math.max(0, Math.round(Number(payload.usage?.input_tokens ?? 0)) || 0),
    outputTokens: Math.max(0, Math.round(Number(payload.usage?.output_tokens ?? 0)) || 0),
  };
  return { text, usage };
}

// ── Proposed-action parsing ───────────────────────────────────────────────────

export interface ProposedCopilotAction {
  title: string;
  summary: string;
}

export interface ParsedCopilotReply {
  // The user-facing reply with any ```action block stripped out.
  cleanedText: string;
  // The parsed action, or null when the reply proposed nothing concrete.
  action: ProposedCopilotAction | null;
}

// Pull the optional ```action block off the model's reply. The fenced block is
// ALWAYS stripped from what the user sees (so the protocol never leaks), but an
// action is only returned when the JSON is valid and carries a real title.
export function parseProposedAction(text: string): ParsedCopilotReply {
  const fence = /```action\s*([\s\S]*?)```/i;
  const match = text.match(fence);
  const cleanedText = text.replace(fence, "").trim();
  if (!match) return { cleanedText, action: null };

  let action: ProposedCopilotAction | null = null;
  try {
    const raw = JSON.parse(match[1].trim()) as Record<string, unknown>;
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    if (title) action = { title, summary: summary || title };
  } catch {
    // Malformed protocol block → no action, but it's still stripped above.
    action = null;
  }
  return { cleanedText, action };
}

// ── Action → action_requests draft ────────────────────────────────────────────

// The approval role a copilot's proposal needs, decided by its DOMAIN (never by
// the model, so gating can't be talked down). Money/finance domains require
// leadership (coo → ceo/coo may approve); every other domain routes to the
// owning department head. Money/outbound therefore stay gated by construction.
export function requiredRoleForMember(member: CouncilMember): RequiredRole {
  const hay = `${member.key} ${member.domain} ${member.title}`.toLowerCase();
  if (/\b(cfo|finance|financial|money|budget|payroll|cash|revenue|spend|invoice)\b/.test(hay)) {
    return "coo";
  }
  return "department_head";
}

// The action_requests row a copilot proposal maps onto (minus org_id / created_by
// / status — the route stamps those so the RLS with_check passes). It mirrors the
// Council's brief shape: source_module='copilot', source_ref carries the member
// key, and proposed_action is NULL — a copilot proposal is recommendation-only,
// so NOTHING auto-executes; a human approves it.
export interface CopilotActionDraft {
  source_module: "copilot";
  source_ref: { member: string; codes: string[] };
  title: string;
  problem: string;
  root_cause: null;
  evidence: never[];
  options: never[];
  recommendation: string;
  estimated_impact: { summary: string };
  confidence: null;
  risk_tier: number;
  required_role: RequiredRole;
  proposed_action: null;
}

export function copilotActionDraft(
  member: CouncilMember,
  action: ProposedCopilotAction,
  requiredRole: RequiredRole
): CopilotActionDraft {
  return {
    source_module: "copilot",
    source_ref: { member: member.key, codes: member.compartment_codes },
    title: action.title,
    problem: action.summary,
    root_cause: null,
    evidence: [],
    options: [],
    recommendation: action.summary,
    estimated_impact: { summary: action.summary },
    confidence: null,
    // Money/leadership proposals carry more blast radius → a higher tier.
    risk_tier: requiredRole === "coo" ? 3 : 2,
    required_role: requiredRole,
    proposed_action: null,
  };
}

// The line appended to the visible reply once a proposal is queued.
export const ACTION_QUEUED_NOTE = "I've queued this for your approval.";
// When the caller's role can't file into the approval queue (RLS INSERT is
// ceo/coo/department_head), we still stay honest about what happened.
export const ACTION_BLOCKED_NOTE =
  "I drafted an action, but it couldn't be queued for approval under your permissions.";
