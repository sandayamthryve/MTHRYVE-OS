// lib/vesper/persona.ts — Vesper, the Operator agent persona.
//
// Vesper is a SECOND assistant persona, distinct from Tony, that runs on the
// same agentic tool-loop pattern (see /api/vesper, which mirrors /api/assistant).
// The division of labour is deliberate and matches the approval spine:
//   • Tony PLANS — he explains, recommends, and proposes.
//   • Vesper EXECUTES — he turns a decision into a filed play on the
//     action_requests spine, then reports what ran and what it returned.
//
// Vesper's tools live HERE (lib/vesper). He is internal and safe by construction:
//   • propose_play — file one of the six internal executor plays as a pending
//     action_request (Tony → Vesper handoff). He never runs it himself; a human
//     approves and the shared executor runs it (unless a low-risk play is
//     configured to auto-run, which still goes through the spine).
//   • preview_scoreboard — a read-only look at the live Growth Scoreboard.
// Nothing external, no spend, no new keys.

import type { UserRole } from "@/types/database";
import type { SessionProfile } from "@/lib/auth/session";
import { computeScoreboard } from "@/lib/vesper/scoreboard";
import { fileVesperPlay } from "@/lib/vesper/propose";
import { VESPER_PLAY_TYPES, VESPER_PLAYS } from "@/lib/vesper/plays";
import { monthToDate } from "@/lib/metrics/windows";

type Shim = { from: (t: string) => any };
export interface VesperToolContext {
  supabase: unknown; // RLS-scoped @supabase/ssr client
  profile: SessionProfile;
}
function db(ctx: VesperToolContext): Shim {
  return ctx.supabase as Shim;
}

export type ToolResult = Record<string, unknown>;

// The persona / system prompt. Kept grounded and honest — same house rules as
// Tony (never invent numbers), but framed as the Operator.
export function buildVesperSystemPrompt(role: UserRole, fullName: string): string {
  const canFile = role === "ceo" || role === "coo" || role === "department_head";
  const playList = VESPER_PLAY_TYPES.map((t) => `- ${t}: ${VESPER_PLAYS[t].description}`).join("\n");
  const lines = [
    `You are Vesper — the Operator for Mthryve's Growth Pods, assisting ${fullName}.`,
    "Mthryve is a Philippine 360 digital-marketing agency and official TikTok Shop & Shopee partner.",
    "Tony PLANS (he recommends and proposes); you EXECUTE (you turn a decision into a filed play,",
    "then report what ran). You are direct, operational, and honest — currency is PHP (₱), and you",
    "NEVER invent numbers: if data is missing, say so plainly.",
    "",
    "You run the Growth Pod machine through SIX internal plays, each dispatched through the same",
    "approval spine the rest of the OS uses. The plays:",
    playList,
    "",
    "How you act:",
    "- To run a play, call propose_play. It files a PENDING request into the Approval Queue; a human",
    "  approves and the OS executes it. You do NOT execute anything yourself — your job ends at 'filed'.",
    "  Report the play you filed and that it's awaiting approval.",
    "- To read the live Growth Scoreboard, call preview_scoreboard (read-only).",
    "HARD LIMITS: everything you do is internal — no outbound messages/posts, no ad spend, no money",
    "movement, no new integrations. Consequential execution only ever happens after a human approves.",
  ];
  if (!canFile) {
    lines.push(
      "",
      "NOTE: this user's role cannot file plays (filing is leadership-only: ceo/coo/department_head).",
      "If they ask to run a play, tell them you'll flag it for their pod lead / leadership instead."
    );
  }
  return lines.join("\n");
}

// Resolve a brand NAME to its id on the caller's RLS client (exact then
// substring, case-insensitive). Returns null when nothing matches.
async function resolveBrandId(ctx: VesperToolContext, name: unknown): Promise<string | null> {
  const q = (typeof name === "string" ? name : "").trim().toLowerCase();
  if (!q) return null;
  const { data } = await db(ctx).from("brands").select("id, name").eq("org_id", ctx.profile.org_id);
  const brands = (data ?? []) as Array<{ id: string; name: string | null }>;
  const exact = brands.find((b) => (b.name ?? "").toLowerCase() === q);
  return (exact ?? brands.find((b) => (b.name ?? "").toLowerCase().includes(q)))?.id ?? null;
}

// ── Tool: propose_play ─────────────────────────────────────────────────────────
async function proposePlay(ctx: VesperToolContext, input: ToolResult): Promise<ToolResult> {
  const play = typeof input.play === "string" ? input.play : "";
  // Build the params from the flexible input, resolving a brand name to an id.
  const params: Record<string, unknown> = {};
  const brandId = (await resolveBrandId(ctx, input.brand)) ?? (typeof input.brand_id === "string" ? input.brand_id : null);
  if (brandId) params.brand_id = brandId;
  for (const k of ["sku", "pillar", "format", "campaign", "category", "window"] as const) {
    if (typeof input[k] === "string" && (input[k] as string).trim()) params[k] = (input[k] as string).trim();
  }
  if (Array.isArray(input.pillars)) params.pillars = input.pillars;
  if (Array.isArray(input.formats)) params.formats = input.formats;
  if (typeof input.limit === "number") params.limit = input.limit;

  const res = await fileVesperPlay(db(ctx), {
    orgId: ctx.profile.org_id,
    actorId: ctx.profile.id,
    actorRole: ctx.profile.role,
    playType: play,
    params,
  });
  if (!res.ok) return { error: res.error ?? "Could not file the play.", routed: res.routed ?? false };
  return {
    ok: true,
    filed: { id: res.id, title: res.title, play, status: res.status, auto_ran: res.autoRan ?? false },
    result: res.result ?? undefined,
    message:
      res.autoRan
        ? `Ran ${play} — see the result.`
        : `Filed "${res.title}" into the Approval Queue as pending — a human approves before it runs.`,
  };
}

// ── Tool: preview_scoreboard ────────────────────────────────────────────────────
async function previewScoreboard(ctx: VesperToolContext): Promise<ToolResult> {
  const board = await computeScoreboard(db(ctx), ctx.profile.org_id, monthToDate());
  return {
    ok: true,
    window: board.window.label,
    org: board.org,
    pods: board.pods.map((p) => ({
      name: p.name,
      lead: p.leadName,
      brands: p.brandCount,
      gmv: p.hasGmv ? p.gmv : null,
      roas: p.roas,
      contribution_pct: p.contributionPct,
      concentration_pct: p.concentrationPct,
    })),
    unassigned_brands: board.unassignedBrandCount,
  };
}

// ── Tool definitions (Anthropic tool schema) ────────────────────────────────────
export const PROPOSE_PLAY_TOOL = {
  name: "propose_play",
  description:
    "File one of Vesper's six internal plays into the Approval Queue as a PENDING action_request (the Tony→Vesper handoff). You do NOT execute it — a human approves and the OS runs it. Use for any 'run/generate/forecast/rank/analyze/compile' operator ask. Everything is internal (no send, no spend).",
  input_schema: {
    type: "object",
    properties: {
      play: {
        type: "string",
        enum: [...VESPER_PLAY_TYPES],
        description: "Which play to run.",
      },
      brand: { type: "string", description: "Brand/client name to scope to (optional; resolved to its id)." },
      sku: { type: "string", description: "For generate_scripts: the product SKU (optional)." },
      pillar: { type: "string", description: "For generate_scripts: a content pillar (optional)." },
      format: { type: "string", description: "For generate_scripts: a content format (optional)." },
      campaign: { type: "string", description: "For match_creators: the campaign name (optional)." },
      category: { type: "string", description: "For match_creators: the target category (optional)." },
      window: { type: "string", description: "For compile_scoreboard: mtd | last7 | last30 | month (optional)." },
      limit: { type: "number", description: "Max results for ranking plays (optional)." },
    },
    required: ["play"],
    additionalProperties: false,
  },
} as const;

export const PREVIEW_SCOREBOARD_TOOL = {
  name: "preview_scoreboard",
  description:
    "Read the live Growth Scoreboard (per pod + org-wide KPIs) for the current month-to-date. Read-only — use to answer 'how are the pods doing' or before proposing a play.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
} as const;

export const VESPER_TOOL_NAMES = new Set<string>([PROPOSE_PLAY_TOOL.name, PREVIEW_SCOREBOARD_TOOL.name]);

export function buildVesperTools() {
  // Both tools are offered to everyone; RLS is the hard gate on propose_play
  // (a non-leadership file is rejected and Vesper relays that it was routed).
  return [PROPOSE_PLAY_TOOL, PREVIEW_SCOREBOARD_TOOL];
}

export async function runVesperTool(name: string, input: unknown, ctx: VesperToolContext): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as ToolResult;
  try {
    switch (name) {
      case "propose_play":
        return await proposePlay(ctx, args);
      case "preview_scoreboard":
        return await previewScoreboard(ctx);
      default:
        return { error: `Unknown Vesper tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Vesper tool failed." };
  }
}
