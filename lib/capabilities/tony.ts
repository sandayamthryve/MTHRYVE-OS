// lib/capabilities/tony.ts — Vesper Core, wired into Tony.
//
// Two capabilities for the assistant loop, both on the caller's RLS client:
//
//   • search_capabilities (READ) — "can we do X / how do we handle Y". Matches
//     public.capabilities by name + domain and answers HONESTLY by status:
//       live    → available now; name the mission team (linked skills/agents/workflows)
//       partial → partially — works but not fully built out
//       planned → not yet — on the roadmap
//       vendor  → not yet — needs a third-party tool we don't own
//     It never claims a planned/vendor capability is available, and always
//     reports the capability + its status so Tony can cite both.
//
//   • create_mission_tasks (ACT) — turn a LIVE/PARTIAL capability into real tasks.
//     Two-phase, human-in-the-loop by construction:
//       DRAFT   (no `tasks` arg) → returns a proposed task list. NOTHING is
//               written. Tony shows it and asks the user to review/edit/confirm.
//       CONFIRM (`tasks` arg present) → creates exactly those reviewed tasks via
//               the existing task flow, each stamped with capability_id.
//     Tony is instructed (below) to ALWAYS draft first and only create after the
//     user confirms — it never auto-creates, and never invents an assignee.
//
// Security: identical contract to read.ts / act.ts — RLS is the wall (org scope +
// leadership-only capability writes don't apply here; task inserts follow the
// user's own task-creation rights). No service key, fixed tools, typed params.

import type { ToolContext, ToolResult } from "@/lib/assistant/tools";
import {
  getCapabilityById,
  searchCapabilities as searchCapabilitiesData,
} from "@/lib/capabilities/data";
import { canRunMission, type Capability } from "@/lib/capabilities/types";
import { createMissionTasks, draftMissionTasks } from "@/lib/capabilities/missions";

type Shim = { from: (t: string) => any };
function db(ctx: ToolContext): Shim {
  return ctx.supabase as unknown as Shim;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// How Tony should frame each status in its answer — the honesty contract in one
// place so the tool result carries the right verdict, not just the raw status.
const AVAILABILITY: Record<Capability["status"], string> = {
  live: "available now",
  partial: "partially available (works, but not fully built out)",
  planned: "not yet — planned / on the roadmap",
  vendor: "not yet — needs a third-party tool we don't own",
};

// Resolve the capability a mission tool refers to: by explicit id first, else by
// name (+ optional domain) via the same ranked search Tony reads with.
async function resolveCapability(
  ctx: ToolContext,
  input: ToolResult
): Promise<{ cap: Capability | null; ambiguous?: Capability[] }> {
  const id = str(input.capability_id);
  if (id) {
    const cap = await getCapabilityById(db(ctx), id);
    if (cap) return { cap };
  }
  const nameQuery = str(input.capability) || str(input.query) || str(input.name);
  const domain = str(input.domain);
  const q = domain ? `${nameQuery} ${domain}` : nameQuery;
  if (!q.trim()) return { cap: null };
  const matches = await searchCapabilitiesData(db(ctx), q, 5);
  if (matches.length === 0) return { cap: null };
  // A clear top match (exact-ish) wins; otherwise hand back the shortlist so Tony
  // can ask which one rather than guessing.
  if (matches.length === 1 || matches[0].score >= matches[1].score + 20) {
    return { cap: matches[0] };
  }
  return { cap: null, ambiguous: matches };
}

// ── search_capabilities ────────────────────────────────────────────────────────
async function runSearch(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const query = str(input.query) || str(input.capability) || str(input.name);
  if (!query) return { error: "Give me something to look up — e.g. 'can we do influencer whitelisting?'." };

  const matches = await searchCapabilitiesData(db(ctx), query, 6);
  if (matches.length === 0) {
    return {
      query,
      count: 0,
      matches: [],
      note: "No capability matches that. Say we don't have that mapped yet — do not claim we can or can't do it beyond what the registry shows.",
    };
  }

  return {
    query,
    count: matches.length,
    matches: matches.map((c) => ({
      capability_id: c.id,
      capability: c.name,
      domain: c.domain,
      status: c.status,
      availability: AVAILABILITY[c.status],
      can_make_tasks: canRunMission(c.status),
      // The "mission team" Tony names for a LIVE/PARTIAL answer.
      mission_team: {
        skills: c.required_skills,
        agents: c.required_agents,
        workflows: c.required_workflows,
        tools: c.required_tools,
      },
      outputs: c.outputs,
      kpis: c.kpis,
      notes: c.notes,
    })),
    note: [
      "Answer HONESTLY by status. LIVE = available now — name the mission team (its skills/agents/workflows).",
      "PARTIAL = partially, works but not fully. PLANNED/VENDOR = not yet / needs a tool — NEVER say it's available.",
      "Always cite the capability name + its status. If a match is LIVE or PARTIAL, you may offer to turn it into",
      "tasks (create_mission_tasks) — ask first, then draft.",
    ].join(" "),
  };
}

// ── create_mission_tasks (draft → confirm) ──────────────────────────────────────
async function runCreateMission(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const { cap, ambiguous } = await resolveCapability(ctx, input);
  if (!cap) {
    if (ambiguous && ambiguous.length) {
      return {
        needs_disambiguation: true,
        message: "More than one capability matches — ask the user which one.",
        matches: ambiguous.map((c) => ({ capability_id: c.id, capability: c.name, domain: c.domain, status: c.status })),
      };
    }
    return { error: "I couldn't find that capability. Ask the user to name it (and its domain if unclear)." };
  }

  if (!canRunMission(cap.status)) {
    return {
      refused: true,
      capability: cap.name,
      status: cap.status,
      message: `"${cap.name}" is ${cap.status} — ${AVAILABILITY[cap.status]}. There's nothing to execute yet, so it can't be turned into tasks. Tell the user honestly.`,
    };
  }

  const context = str(input.context);
  const tasksArg = input.tasks;

  // CONFIRM phase — a reviewed list was passed, so create exactly those tasks.
  if (Array.isArray(tasksArg) && tasksArg.length > 0) {
    const result = await createMissionTasks(db(ctx), ctx.profile, cap, tasksArg);
    if (!result.ok) return { error: result.error };
    return {
      ok: true,
      tier: "confirmed",
      created: result.created,
      capability: cap.name,
      status: cap.status,
      message: `Created ${result.created} task${result.created === 1 ? "" : "s"} for "${cap.name}", each linked to the capability. They're on the task board now.`,
    };
  }

  // DRAFT phase — no reviewed list yet. Propose tasks; write nothing.
  const draft = draftMissionTasks(cap, context);
  return {
    phase: "draft",
    capability_id: cap.id,
    capability: cap.name,
    domain: cap.domain,
    status: cap.status,
    availability: AVAILABILITY[cap.status],
    draft_tasks: draft.map((t) => ({
      title: t.title,
      description: t.description,
      priority: t.priority,
      due_date: t.due_date,
      suggested_team: t.assignee_hint,
    })),
    note: [
      "This is a DRAFT — nothing was created. Show the user this task list plainly and ask them to review, edit,",
      "remove, or confirm. Do NOT create tasks until they say yes. When they confirm, call create_mission_tasks",
      "AGAIN with the SAME capability_id and a `tasks` array of the final reviewed tasks (title, description,",
      "priority, due_date, and assignee_id ONLY if they named a real person — never invent an owner). For a",
      "hands-on review they can also open Vesper Core and use 'Create mission tasks' on the capability.",
    ].join(" "),
  };
}

// ── Tool definitions (Anthropic tool schema) ────────────────────────────────────
export const SEARCH_CAPABILITIES_TOOL = {
  name: "search_capabilities",
  description:
    "VESPER CORE (capability registry). Look up what Mthryve can actually do. Use for 'what can we do about X', 'can we do Y', 'how do we handle Z'. Matches capabilities by name + domain and returns each with its STATUS so you answer honestly: live = available now (name the mission team — its skills/agents/workflows); partial = partially; planned/vendor = not yet / needs a tool (NEVER say it's available). Always cite the capability + status. For a live/partial match you may then offer to turn it into tasks.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What the user wants to do, in their words (e.g. 'influencer whitelisting', 'forecast restock')." },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

export const CREATE_MISSION_TASKS_TOOL = {
  name: "create_mission_tasks",
  description:
    "VESPER CORE. Turn a LIVE or PARTIAL capability into real, linked tasks — ALWAYS draft-first, then create only after the user confirms. Call WITHOUT `tasks` to get a DRAFT task list (nothing is written); show it and ask the user to review/edit/confirm. Call AGAIN with the same capability_id and a `tasks` array of the reviewed tasks to actually create them (each is stamped with capability_id for traceability). Never create without an explicit user confirm. Planned/vendor capabilities are refused — there's nothing to execute yet. Never invent an assignee: only set assignee_id when the user named a real person.",
  input_schema: {
    type: "object",
    properties: {
      capability_id: { type: "string", description: "The capability's id (from search_capabilities). Preferred over name." },
      capability: { type: "string", description: "The capability name, if you don't have its id." },
      context: { type: "string", description: "The user's context/goal for this mission (optional but improves the draft)." },
      tasks: {
        type: "array",
        description: "CONFIRM phase only: the final reviewed tasks to create. Omit entirely to DRAFT.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
            due_date: { type: "string", description: "YYYY-MM-DD, or omit." },
            assignee_id: { type: "string", description: "A REAL user id only — never a guessed name. Omit if unknown." },
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

export const CAPABILITY_READ_TOOL_NAMES: Set<string> = new Set([SEARCH_CAPABILITIES_TOOL.name]);
export const CAPABILITY_ACT_TOOL_NAMES: Set<string> = new Set([CREATE_MISSION_TASKS_TOOL.name]);

// Dispatch — never throws; any failure becomes { error } so the loop continues.
export async function runCapabilityTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as ToolResult;
  try {
    switch (name) {
      case SEARCH_CAPABILITIES_TOOL.name:
        return await runSearch(ctx, args);
      case CREATE_MISSION_TASKS_TOOL.name:
        return await runCreateMission(ctx, args);
      default:
        return { error: `Unknown capability tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Capability tool failed." };
  }
}

// Pages whose data a capability tool changed, for revalidation after the turn.
export function capabilityRevalidatePaths(name: string): string[] {
  if (name === CREATE_MISSION_TASKS_TOOL.name) return ["/tasks", "/vesper/core"];
  return [];
}

// System-prompt block appended for every caller — the honesty contract + the
// draft→confirm mission flow travel with the tools.
export function buildCapabilityPrompt(): string {
  return [
    "=== Vesper Core (capability registry + missions) ===",
    "You can look up what Mthryve can actually DO and turn it into work.",
    "- search_capabilities — for 'what can we do about X', 'can we do Y', 'how do we handle Z'.",
    "  Answer HONESTLY by the capability's status, and ALWAYS cite the capability name + status:",
    "    • live    → 'we can do that now' — name the mission team (its skills / agents / workflows).",
    "    • partial → 'we can partially' — it works but isn't fully built out.",
    "    • planned → 'not yet — it's planned.'  • vendor → 'not yet — it needs a tool we don't own.'",
    "  NEVER claim a planned or vendor capability is available. Don't overstate a partial one.",
    "- create_mission_tasks — ONLY for live/partial capabilities. After answering a capability question,",
    "  you may OFFER: 'want me to turn this into tasks?'. If they say yes, call it WITHOUT `tasks` to draft,",
    "  show the drafted list, and let them edit/remove/confirm. Create the tasks ONLY after they confirm,",
    "  by calling it again with the reviewed `tasks`. Never auto-create, never invent an assignee. Planned/",
    "  vendor capabilities can't become tasks — say so honestly.",
  ].join("\n");
}
