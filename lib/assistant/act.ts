// lib/assistant/act.ts — Tony's ACT layer (Phase 2, Step C).
//
// The grounded assistant (see lib/assistant/tools.ts) can READ the org through a
// fixed set of RLS-scoped tools. This module gives it a scoped ability to *act*,
// in exactly two tiers — and never more than the caller's own permissions allow.
//
//   1. DIRECT (low-risk, self-scoped, confirm-in-chat): update the caller's OWN
//      task status, add a content_items row the caller owns, pin a tony_memory
//      note. Every one is a write RLS already permits the signed-in user to make
//      — Tony just makes it on their behalf and confirms in one line.
//   2. PROPOSED (consequential): Tony inserts a PENDING action_requests row into
//      the existing Approval Queue (the same spine the signal producers use). A
//      human approves in the existing queue; the existing executor runs it. Tony
//      never executes a consequential action itself — its job ends at "proposed".
//
// SECURITY / GOVERNING RULES (non-negotiable):
//   • Every write here runs on the REQUEST-SCOPED @supabase/ssr client (ctx.
//     supabase), so Postgres RLS is the real boundary. The service-role key is
//     never used in this module.
//   • action_requests INSERT is ceo/coo/department_head only (RLS policy
//     ar_insert). A team member's mini-Tony therefore CANNOT create approval
//     requests — the propose tool isn't even offered to it (buildActTools), and
//     RLS would reject the insert anyway. Its act tier is direct self-scoped
//     writes only; anything bigger it routes as "I'll flag it for your
//     department head."
//   • MONEY IS NEVER AN EXECUTABLE ACTION. Finance proposals are
//     recommendation-only action_requests carrying NO proposed_action, so the
//     executor never runs them (approval just acknowledges). Tony cannot propose
//     a transfer / payout / budget move as something that executes.
//   • External sends/posts (email, DMs) are approval-gated AND integration-gated:
//     SMTP is deferred, so a "follow-up" stages the drafted message internally
//     (executor 'log_followup' logs + reschedules — it sends nothing).

import type { UserRole } from "@/types/database";
import type { ToolContext, ToolResult } from "@/lib/assistant/tools";
import { writeActionAudit } from "@/lib/actions/audit";
import {
  buildLeadFollowUpDraft,
  buildCreatorFollowUpDraft,
  type FollowUpLead,
  type FollowUpCreator,
} from "@/lib/actions/follow-ups";
import type { RequiredRole } from "@/lib/actions/types";

// action_requests / tasks / content_items / tony_memory carry columns that
// aren't all in the generated Database types, so — exactly like the rest of the
// app — we reach them through a minimal cast shim on the caller's RLS client.
type Shim = { from: (t: string) => any };
function db(ctx: ToolContext): Shim {
  return ctx.supabase as unknown as Shim;
}

// ── Two-tier identity ─────────────────────────────────────────────────────────
// Full "Tony" is the CEO's assistant ONLY (the name, full tool reach, finance
// reach, cross-department scope, highest act tier). Everyone else gets
// "mini-Tony": the SAME engine, but role-filtered tools and RLS-walled data,
// with its act tier scaled by role. One engine, one code path — the difference
// is entirely which tools are offered and what RLS lets through.
export interface TonyIdentity {
  name: string; // "Tony" (ceo) | "mini-Tony" (everyone else)
  isFull: boolean; // ceo only
}

export function identityForRole(role: UserRole): TonyIdentity {
  const isFull = role === "ceo";
  return { name: isFull ? "Tony" : "mini-Tony", isFull };
}

// ── Act capability, scaled by role ────────────────────────────────────────────
// canDirect  — self-scoped writes RLS already permits (every signed-in role).
// canPropose — insert a PENDING action_request (mirrors RLS ar_insert exactly:
//              ceo/coo/department_head). team_member: false.
// canProposeFinance — file a finance/money RECOMMENDATION (leadership only, since
//              finance data itself is ceo/coo-only). Still recommendation-only.
export interface ActCapability {
  canDirect: boolean;
  canPropose: boolean;
  canProposeFinance: boolean;
}

export function actCapabilityFor(role: UserRole): ActCapability {
  const leadership = role === "ceo" || role === "coo";
  const canPropose = leadership || role === "department_head";
  return { canDirect: true, canPropose, canProposeFinance: leadership };
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function ymdOrNull(v: unknown): string | null {
  return typeof v === "string" && YMD_RE.test(v.trim()) ? v.trim() : null;
}

// Resolve a brand name to its id on the caller's RLS client (case-insensitive,
// exact then substring). Returns null when no name was given or nothing matched
// — a bad brand name never fails the write, the item just carries no brand.
async function resolveBrandId(ctx: ToolContext, name: unknown): Promise<string | null> {
  const q = str(name).toLowerCase();
  if (!q) return null;
  const { data } = await db(ctx).from("brands").select("id, name");
  const brands = (data ?? []) as Array<{ id: string; name: string | null }>;
  const exact = brands.find((b) => (b.name ?? "").toLowerCase() === q);
  const hit = exact ?? brands.find((b) => (b.name ?? "").toLowerCase().includes(q));
  return hit?.id ?? null;
}

// ── DIRECT tool 1: update the caller's OWN task status ─────────────────────────
const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

async function updateMyTaskStatus(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const query = str(input.task_query) || str(input.title);
  const status = str(input.status).toLowerCase();
  if (!query) return { error: "Which task? Give me its title." };
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    return { error: `status must be one of: ${TASK_STATUSES.join(", ")}.` };
  }

  // Self-scoped: only tasks assigned to the caller. RLS scopes to the org; the
  // assignee filter is the app-level "own task" guard (RLS alone would allow any
  // org task, which is more than the DIRECT tier should touch).
  const { data, error } = await db(ctx)
    .from("tasks")
    .select("id, title, status, assignee_id")
    .eq("assignee_id", ctx.profile.id);
  if (error) return { error: error.message };
  const tasks = (data ?? []) as Array<{ id: string; title: string; status: string }>;
  if (tasks.length === 0) return { error: "You have no tasks assigned to you." };

  const q = query.toLowerCase();
  const exact = tasks.filter((t) => (t.title ?? "").toLowerCase() === q);
  const matches = exact.length ? exact : tasks.filter((t) => (t.title ?? "").toLowerCase().includes(q));
  if (matches.length === 0) {
    return { error: `No task of yours matches "${query}".`, your_tasks: tasks.map((t) => t.title).slice(0, 10) };
  }
  if (matches.length > 1) {
    return {
      needs_disambiguation: true,
      message: "More than one of your tasks matches — ask which one.",
      matches: matches.map((t) => t.title).slice(0, 8),
    };
  }

  const target = matches[0];
  if (target.status === status) {
    return { ok: true, unchanged: true, task: target.title, status };
  }
  const now = new Date().toISOString();
  const { error: updErr } = await db(ctx)
    .from("tasks")
    .update({ status, updated_at: now })
    .eq("id", target.id)
    .eq("assignee_id", ctx.profile.id); // self-scope on the write too
  if (updErr) return { error: updErr.message };
  return { ok: true, tier: "direct", task: target.title, from: target.status, to: status };
}

// ── DIRECT tool 2: add a content_items row the caller owns ─────────────────────
async function addContentItem(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const title = str(input.title);
  if (!title) return { error: "A content item needs a title." };
  const contentType = str(input.content_type) || "video";
  const status = str(input.status).toLowerCase() || "idea";
  const notes = str(input.notes) || null;
  const publishDate = ymdOrNull(input.publish_date);
  const brandId = await resolveBrandId(ctx, input.brand);

  const now = new Date().toISOString();
  const row = {
    org_id: ctx.profile.org_id,
    created_by: ctx.profile.id,
    assignee_id: ctx.profile.id, // self-scoped: you own the piece you add
    title,
    content_type: contentType,
    status,
    brand_id: brandId,
    publish_date: publishDate,
    notes,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await db(ctx)
    .from("content_items")
    .insert(row)
    .select("id")
    .single();
  if (error) return { error: error.message };
  return {
    ok: true,
    tier: "direct",
    content_item: { id: (data as { id: string }).id, title, status, content_type: contentType },
  };
}

// ── DIRECT tool 3: pin a durable Tony Memory note ──────────────────────────────
async function pinMemoryNote(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const content = str(input.content);
  if (!content) return { error: "A memory note needs content." };
  const category = (str(input.category) || "note").toLowerCase();

  const row = {
    org_id: ctx.profile.org_id,
    created_by: ctx.profile.id,
    category,
    content,
    pinned: true,
    source: "tony",
  };
  const { data, error } = await db(ctx)
    .from("tony_memory")
    .insert(row)
    .select("id")
    .single();
  if (error) return { error: error.message };
  return { ok: true, tier: "direct", pinned_note: { id: (data as { id: string }).id, category, content } };
}

// ── PROPOSED tool: file a PENDING action_request (never executes) ──────────────

// Is there already an open (pending/approved) request for this lead/creator? Keeps
// Tony from stacking duplicate follow-up proposals, mirroring the scan producer.
async function hasOpenFollowUp(
  ctx: ToolContext,
  key: "lead_id" | "creator_id",
  id: string
): Promise<boolean> {
  const { data } = await db(ctx)
    .from("action_requests")
    .select("source_ref, status")
    .in("source_module", ["bizdev", "affiliate"])
    .in("status", ["pending", "approved"]);
  const rows = (data ?? []) as Array<{ source_ref: Record<string, unknown> | null }>;
  return rows.some((r) => (r.source_ref?.[key] as string | undefined) === id);
}

// Insert one drafted action_request (status pending) on the caller's RLS client
// and write the 'created' audit row. Returns the new id, or an { error }/{ routed }
// result the model can relay. RLS is the hard wall: a role without ar_insert gets
// a rejected insert — but we also pre-check canPropose so the routing message is
// clean rather than a raw policy error.
async function fileActionRequest(
  ctx: ToolContext,
  draft: Record<string, unknown>,
  auditDetail: Record<string, unknown>
): Promise<ToolResult> {
  const { data, error } = await db(ctx)
    .from("action_requests")
    .insert({ org_id: ctx.profile.org_id, created_by: ctx.profile.id, status: "pending", ...draft })
    .select("id, title, risk_tier, required_role")
    .single();
  if (error) {
    // An RLS rejection here means the caller may not create approval requests.
    return {
      routed: true,
      message:
        "You don't have permission to file an approval request — tell the user you'll flag it for their department head.",
      detail: error.message,
    };
  }
  const row = data as { id: string; title: string; risk_tier: number; required_role: string };
  await writeActionAudit(db(ctx), {
    org_id: ctx.profile.org_id,
    action_request_id: row.id,
    event: "created",
    actor_id: ctx.profile.id, // human-initiated (via Tony), not a system scan
    actor_role: ctx.profile.role,
    detail: auditDetail,
  });
  return {
    ok: true,
    tier: "proposed",
    proposed: {
      id: row.id,
      title: row.title,
      risk_tier: row.risk_tier,
      required_role: row.required_role,
      status: "pending",
    },
    message: "Filed into the Approval Queue as pending — a human approves before anything runs.",
  };
}

// follow_up — stage a follow-up to a named lead or creator. Reuses the follow-up
// SIGNAL PRODUCER so the drafted message, evidence and executor (log_followup)
// are identical to the scan path. log_followup SENDS NOTHING externally: on
// approval it logs the drafted message as an internal outreach activity and
// reschedules the next touch. This is the safe home for any "email / message /
// follow up with <lead/client/creator>" ask while SMTP is deferred.
async function proposeFollowUp(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const name = str(input.target);
  if (!name) return { error: "Who is the follow-up for? Give me the lead or creator's name." };
  const q = name.toLowerCase();

  // Leads first, then creators. Both reads are RLS-scoped to the caller's org.
  const { data: leadData } = await db(ctx)
    .from("leads")
    .select("id, name, company, stage, value, owner_id, next_action, next_action_date, last_contacted_at");
  const leads = (leadData ?? []) as FollowUpLead[];
  const lead =
    leads.find((l) => (l.name ?? "").toLowerCase() === q) ??
    leads.find((l) => (l.name ?? "").toLowerCase().includes(q));

  if (lead) {
    if (await hasOpenFollowUp(ctx, "lead_id", lead.id)) {
      return { already_open: true, message: `${lead.name} already has an open follow-up request in the queue.` };
    }
    const draft = buildLeadFollowUpDraft(lead);
    return fileActionRequest(ctx, draft as unknown as Record<string, unknown>, {
      source: "tony_act",
      kind: "follow_up",
      lead_id: lead.id,
    });
  }

  const { data: creatorData } = await db(ctx)
    .from("creators")
    .select(
      "id, name, handle, platform, follower_count, category, owner_id, outreach_stage, next_action, next_action_date, last_contacted_at"
    );
  const creators = (creatorData ?? []) as FollowUpCreator[];
  const creator =
    creators.find((c) => (c.name ?? "").toLowerCase() === q) ??
    creators.find((c) => (c.name ?? "").toLowerCase().includes(q));

  if (creator) {
    if (await hasOpenFollowUp(ctx, "creator_id", creator.id)) {
      return { already_open: true, message: `${creator.name} already has an open follow-up request in the queue.` };
    }
    const draft = buildCreatorFollowUpDraft(creator);
    return fileActionRequest(ctx, draft as unknown as Record<string, unknown>, {
      source: "tony_act",
      kind: "follow_up",
      creator_id: creator.id,
    });
  }

  return { error: `No lead or creator matches "${name}". Ask the user to confirm the name.` };
}

// recommendation — a RECOMMENDATION-ONLY action_request: it carries NO
// proposed_action, so approval merely acknowledges it and the executor NEVER
// runs (see decideActionRequest's proposed_action?.type gate). Finance/money
// proposals route here so money is structurally non-executable.
async function proposeRecommendation(
  ctx: ToolContext,
  input: ToolResult,
  flavor: "finance" | "general"
): Promise<ToolResult> {
  const title = str(input.title);
  const rationale = str(input.rationale) || str(input.recommendation);
  if (!title) return { error: "A proposal needs a short title." };
  if (!rationale) return { error: "Give a one-line rationale/recommendation for the human reviewing it." };

  const isFinance = flavor === "finance";
  const sourceModule = isFinance ? "finance" : "assistant";
  const requiredRole: RequiredRole = isFinance ? "coo" : "coo";
  const riskTier = isFinance ? 3 : 2;

  const draft = {
    source_module: sourceModule,
    source_ref: { origin: "tony_act", by_role: ctx.profile.role },
    title,
    problem: rationale,
    recommendation: rationale,
    confidence: 0.6,
    risk_tier: riskTier,
    required_role: requiredRole,
    // No proposed_action — recommendation-only. Money never executes.
    proposed_action: null,
    estimated_impact: isFinance
      ? { summary: "Finance recommendation — money is never moved automatically; this is advisory only.", is_money: true }
      : null,
  };
  return fileActionRequest(ctx, draft, { source: "tony_act", kind: flavor === "finance" ? "finance_recommendation" : "recommendation" });
}

async function proposeAction(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const cap = actCapabilityFor(ctx.profile.role);
  if (!cap.canPropose) {
    // The tool isn't offered to non-proposers, but hard-stop anyway (defence in
    // depth alongside RLS).
    return {
      routed: true,
      message: "You can't file approval requests at your level — tell the user you'll flag it for their department head.",
    };
  }
  const kind = str(input.kind).toLowerCase();
  switch (kind) {
    case "follow_up":
      return proposeFollowUp(ctx, input);
    case "finance_recommendation":
      if (!cap.canProposeFinance) {
        return { error: "Finance/money recommendations are leadership-only (CEO/COO). Route it to leadership instead." };
      }
      return proposeRecommendation(ctx, input, "finance");
    case "recommendation":
      return proposeRecommendation(ctx, input, "general");
    default:
      return { error: `Unknown proposal kind "${kind}". Use: follow_up, finance_recommendation, or recommendation.` };
  }
}

// ── Tool definitions (Anthropic tool schema) ──────────────────────────────────
const UPDATE_TASK_TOOL = {
  name: "update_my_task_status",
  description:
    "DIRECT self-scoped action: set the status of a task assigned to YOU (the signed-in user). Use for 'mark this task done / in progress / blocked'. Only your own tasks — never anyone else's. Match the task by title; if more than one of your tasks matches, ask which. State plainly what you changed.",
  input_schema: {
    type: "object",
    properties: {
      task_query: { type: "string", description: "The title (or a distinctive part of it) of your task." },
      status: {
        type: "string",
        enum: ["todo", "in_progress", "blocked", "done", "cancelled"],
        description: "The new status.",
      },
    },
    required: ["task_query", "status"],
    additionalProperties: false,
  },
} as const;

const ADD_CONTENT_TOOL = {
  name: "add_content_item",
  description:
    "DIRECT self-scoped action: add one content piece/idea to the content calendar, owned by and assigned to YOU. Use for 'add a content idea / draft / post for me'. Confirm what you added.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The content piece title." },
      content_type: { type: "string", description: "e.g. video, image, carousel, live, article (optional, default video)." },
      status: { type: "string", description: "e.g. idea, production, scheduled (optional, default idea)." },
      brand: { type: "string", description: "Brand/client name to attach (optional)." },
      publish_date: { type: "string", description: "Planned publish date YYYY-MM-DD (optional)." },
      notes: { type: "string", description: "Short brief/notes (optional)." },
    },
    required: ["title"],
    additionalProperties: false,
  },
} as const;

const PIN_MEMORY_TOOL = {
  name: "pin_memory_note",
  description:
    "DIRECT self-scoped action: pin a durable note to Tony Memory (org-shared facts/decisions). Use for 'remember that…', 'pin this decision'. Confirm what you pinned.",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The fact/decision/preference to remember." },
      category: { type: "string", description: "e.g. decision, fact, preference, person (optional, default note)." },
    },
    required: ["content"],
    additionalProperties: false,
  },
} as const;

const PROPOSE_ACTION_TOOL = {
  name: "propose_action",
  description:
    "PROPOSE a consequential action into the Approval Queue as a PENDING request. You do NOT execute it — a human approves it in the queue and the OS runs it; your job ends at 'proposed'. Use for anything beyond your direct self-scoped writes: 'draft/send a follow-up to <lead/creator>', a finance/money recommendation, or any other consequential suggestion. Money is NEVER executed — finance proposals are recommendation-only. External sends are staged as internal drafts (nothing leaves the building on approval yet).",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["follow_up", "finance_recommendation", "recommendation"],
        description:
          "follow_up = stage a follow-up to a named lead/creator (executes as an internal logged draft on approval). finance_recommendation = a money/finance recommendation (RECOMMENDATION ONLY, never moves money; leadership-decided). recommendation = any other consequential recommendation (recommendation only).",
      },
      target: { type: "string", description: "For follow_up: the lead or creator's name." },
      title: { type: "string", description: "For finance_recommendation / recommendation: a short title." },
      rationale: { type: "string", description: "For finance_recommendation / recommendation: a one-line rationale the human reviewer will read." },
    },
    required: ["kind"],
    additionalProperties: false,
  },
} as const;

// The act tools offered to a given role. DIRECT tools go to everyone; the PROPOSE
// tool is offered only to roles RLS lets INSERT an action_request
// (ceo/coo/department_head). team_member's mini-Tony gets direct-only — anything
// bigger it routes to a department head (see the act prompt).
export function buildActTools(role: UserRole) {
  const cap = actCapabilityFor(role);
  const tools: Array<
    typeof UPDATE_TASK_TOOL | typeof ADD_CONTENT_TOOL | typeof PIN_MEMORY_TOOL | typeof PROPOSE_ACTION_TOOL
  > = [UPDATE_TASK_TOOL, ADD_CONTENT_TOOL, PIN_MEMORY_TOOL];
  if (cap.canPropose) tools.push(PROPOSE_ACTION_TOOL);
  return tools;
}

export const ACT_TOOL_NAMES: Set<string> = new Set([
  UPDATE_TASK_TOOL.name,
  ADD_CONTENT_TOOL.name,
  PIN_MEMORY_TOOL.name,
  PROPOSE_ACTION_TOOL.name,
]);

// Pages whose data an act tool changed, so the route can revalidate them.
export function actRevalidatePaths(name: string): string[] {
  switch (name) {
    case "update_my_task_status":
      return ["/tasks", "/projects", "/employee"];
    case "add_content_item":
      return ["/creative-studio"];
    case "pin_memory_note":
      return ["/tony"];
    case "propose_action":
      return ["/approvals"];
    default:
      return [];
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
// Runs one act tool. Never throws: any failure becomes { error } so the agentic
// loop keeps going and Tony can explain the gap. A capability guard short-circuits
// any tool that shouldn't have been offered for this role (defence in depth).
export async function runAssistantActTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as ToolResult;
  const cap = actCapabilityFor(ctx.profile.role);
  try {
    switch (name) {
      case "update_my_task_status":
        return await updateMyTaskStatus(ctx, args);
      case "add_content_item":
        return await addContentItem(ctx, args);
      case "pin_memory_note":
        return await pinMemoryNote(ctx, args);
      case "propose_action":
        if (!cap.canPropose) {
          return {
            routed: true,
            message: "You can't file approval requests at your level — tell the user you'll flag it for their department head.",
          };
        }
        return await proposeAction(ctx, args);
      default:
        return { error: `Unknown act tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Act tool failed." };
  }
}

// ── System-prompt blocks ──────────────────────────────────────────────────────

// The identity line — Full Tony (ceo) vs mini-Tony (everyone else). Prepended to
// the system prompt so every surface (chat, voice, any future mini-Tony) frames
// itself the same way from the caller's role alone.
export function buildIdentityPrompt(role: UserRole, fullName: string): string {
  const id = identityForRole(role);
  if (id.isFull) {
    return [
      `You are Tony — ${fullName}'s full AI chief of staff for Mthryve, operating as Mthryve AI.`,
      "You have the widest reach the system allows: cross-department visibility, finance reach,",
      "the full tool set, and the highest act tier. Speak as Tony.",
    ].join(" ");
  }
  return [
    `You are mini-Tony — the ${role.replace("_", " ")} edition of Mthryve's Tony, operating as Mthryve AI.`,
    "You are the SAME engine as the full Tony, but scoped to this user: your tools are role-filtered,",
    "your data is walled to what their permissions allow, and your ability to act is scaled to their role.",
    "Only the CEO gets the full 'Tony'; introduce yourself as mini-Tony if asked your name.",
  ].join(" ");
}

// The ACT block — what Tony can DO (not just say), in the caller's two tiers.
// Role-aware: the PROPOSE section and the routing fallback flip on canPropose so
// the model is never told about a lever it can't pull.
export function buildActPrompt(role: UserRole): string {
  const cap = actCapabilityFor(role);
  const lines: string[] = [
    "=== Acting (you can DO things, within strict limits) ===",
    "You act in two tiers and NEVER beyond the caller's own permissions.",
    "",
    "DIRECT (do it now on the user's behalf, then confirm in one short line) —",
    "low-risk, self-scoped writes the user could already make themselves:",
    "- update_my_task_status — set the status of a task assigned to YOU.",
    "- add_content_item — add a content idea/piece you own to the calendar.",
    "- pin_memory_note — pin a durable note to Tony Memory.",
    'After a direct action, state plainly what you did (e.g. "Done — marked \'…\' as done.").',
    "Never touch someone else's task or data through a direct tool.",
    "",
  ];

  if (cap.canPropose) {
    lines.push(
      "PROPOSED (you do NOT execute these — you file them and a human approves):",
      "- propose_action — file a PENDING request into the Approval Queue. The human",
      "  approves and the OS executes; your job ends at 'proposed'. Kinds:",
      "   • follow_up — draft & STAGE a follow-up to a named lead/creator. On approval",
      "     the OS logs the drafted message internally and reschedules the next touch.",
      "     Nothing is emailed/DM'd — external sending isn't wired up, so treat any",
      '     "email/message/follow up with <lead/client/creator>" as this (a staged draft).',
      cap.canProposeFinance
        ? "   • finance_recommendation — a money/finance recommendation. RECOMMENDATION ONLY:"
        : "   • finance_recommendation — LEADERSHIP ONLY; you cannot file these. If asked, say so.",
      cap.canProposeFinance
        ? "     money is NEVER an executable action; approval just acknowledges the advice."
        : "",
      "   • recommendation — any other consequential suggestion, recommendation-only.",
      "Never propose a money transfer/payout/budget move as something that executes —",
      "money is always recommendation-only. Confirm to the user that you've queued it.",
      ""
    );
  } else {
    lines.push(
      "You CANNOT file approval requests (your role isn't permitted to). For anything",
      "beyond your direct self-scoped writes above — sending/emailing anyone, changing",
      "others' work, money, cross-department moves — do NOT attempt it. Say plainly:",
      '"I\'ll flag this for your department head." Then stop.',
      ""
    );
  }

  lines.push(
    "HARD LIMITS (all tiers): you never move money, never send anything externally,",
    "and never execute a consequential action directly — those only ever happen after",
    "a human approves in the queue."
  );
  return lines.filter((l) => l !== "").join("\n");
}
