// lib/atlas/tools.ts — Atlas knowledge tools (READ + proposed).
import type { SessionProfile } from "@/lib/auth/session";
import { searchKnowledge } from "@/lib/knowledge/search";
import { writeActionAudit } from "@/lib/actions/audit";

type Shim = { from: (t: string) => any };
export type AtlasToolContext = { supabase: unknown; profile: SessionProfile };
function db(ctx: AtlasToolContext): Shim { return ctx.supabase as Shim; }
export type ToolResult = Record<string, unknown>;

async function searchAtlasKnowledge(input: ToolResult): Promise<ToolResult> {
  const q = typeof input.query === "string" ? input.query.trim() : "";
  if (!q) return { error: "What should I search the Knowledge Base for?" };
  try {
    const chunks = await searchKnowledge(q, 6).catch(() => null);
    if (!chunks) return { count: 0, chunks: [], note: "Knowledge search unavailable." };
    if (chunks.length === 0) return { count: 0, chunks: [], note: "No docs matched." };
    return { count: chunks.length, chunks: chunks.map((c: any) => ({ source_title: c.title, source_type: c.source_type, excerpt: c.content })), note: "Cite source_title." };
  } catch (e) { return { error: e instanceof Error ? e.message : "Search failed." }; }
}

async function recallAtlasMemory(ctx: AtlasToolContext, input: ToolResult): Promise<ToolResult> {
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const category = typeof input.category === "string" ? input.category.trim().toLowerCase() : null;
  try {
    let q = db(ctx).from("tony_memory").select("category, content, pinned, updated_at").order("pinned", { ascending: false }).order("updated_at", { ascending: false }).limit(200) as any;
    if (category) q = q.eq("category", category);
    const { data, error } = await q;
    if (error) return { error: error.message };
    let rows = (data ?? []).filter((m: any) => m.content);
    if (query) {
      const terms = query.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
      rows = rows.filter((m: any) => { const hay = `${m.category ?? ""} ${m.content ?? ""}`.toLowerCase(); return terms.some((t) => hay.includes(t)); });
    }
    return { count: rows.slice(0, 20).length, memory: rows.slice(0, 20), note: rows.length ? undefined : "No memory matches." };
  } catch (e) { return { error: e instanceof Error ? e.message : "Recall failed." }; }
}

async function getGraphSnapshot(ctx: AtlasToolContext): Promise<ToolResult> {
  try {
    const [{ data: orgs }, { data: depts }, { data: brands }, { data: caps }] = await Promise.all([
      db(ctx).from("organizations").select("id, name").limit(1) as any,
      db(ctx).from("departments").select("id, name").order("name", { ascending: true }) as any,
      db(ctx).from("brands").select("id, name").order("name", { ascending: true }) as any,
      db(ctx).from("capabilities").select("id, name, status").limit(5) as any,
    ]);
    return {
      org: (orgs ?? [])[0] ?? null,
      departments: { count: (depts ?? []).length, items: (depts ?? []).slice(0, 10).map((d: any) => d.name) },
      brands: { count: (brands ?? []).length, items: (brands ?? []).slice(0, 10).map((b: any) => b.name) },
      capabilities_sample: { count: (caps ?? []).length },
      note: "Live graph nodes — honest snapshot, no fabrication.",
    };
  } catch (e) { return { error: e instanceof Error ? e.message : "Graph failed." }; }
}

async function listCapabilities(ctx: AtlasToolContext, input: ToolResult): Promise<ToolResult> {
  const q = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  try {
    const { data, error } = await db(ctx).from("capabilities").select("id, name, domain, status").order("name", { ascending: true }).limit(30) as any;
    if (error) return { error: error.message };
    let rows = (data ?? []) as any[];
    if (q) rows = rows.filter((r: any) => `${r.name} ${r.domain}`.toLowerCase().includes(q));
    return { count: rows.length, items: rows.slice(0, 10), note: rows.length ? "Cite status live/partial/planned." : "No capabilities matched." };
  } catch (e) { return { error: e instanceof Error ? e.message : "List failed." }; }
}

async function proposeAtlasCapture(ctx: AtlasToolContext, input: ToolResult): Promise<ToolResult> {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (!title) return { error: "A capture needs a title." };
  const canPropose = ctx.profile.role === "ceo" || ctx.profile.role === "coo" || ctx.profile.role === "department_head";
  if (!canPropose) return { routed: true, message: "You can't file captures at your level — flag for leadership." };
  try {
    const draft: Record<string, unknown> = {
      source_module: "atlas",
      source_ref: { by: ctx.profile.id },
      title: `Atlas capture · ${title}`,
      problem: detail || title,
      recommendation: detail || `Capture knowledge: ${title}`,
      confidence: 0.6,
      risk_tier: 1,
      required_role: "department_head",
      proposed_action: { type: "atlas_capture", payload: { title, detail } },
      status: "pending",
    };
    const { data, error } = await (db(ctx).from("action_requests") as any).insert({ org_id: ctx.profile.org_id, created_by: ctx.profile.id, status: "pending", ...draft }).select("id, title").single();
    if (error) return { routed: true, message: "No permission to file — flag for leadership.", detail: error.message };
    const row = data as any;
    await writeActionAudit(db(ctx) as any, { org_id: ctx.profile.org_id, action_request_id: row.id, event: "created", actor_id: ctx.profile.id, actor_role: ctx.profile.role, detail: { source: "atlas", kind: "capture" } });
    return { ok: true, tier: "proposed", proposed: { id: row.id, title: row.title }, message: "Filed Atlas capture into Approvals as pending — HR/leadership approves." };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not file." }; }
}

export const SEARCH_ATLAS_KNOWLEDGE_TOOL = { name: "search_atlas_knowledge", description: "Search Knowledge Base for SOPs/policies/contracts — cite source_title.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } as const;
export const RECALL_ATLAS_MEMORY_TOOL = { name: "recall_atlas_memory", description: "Recall durable memory facts by category/query (pinned first).", input_schema: { type: "object", properties: { query: { type: "string" }, category: { type: "string" } }, additionalProperties: false } } as const;
export const GET_GRAPH_SNAPSHOT_TOOL = { name: "get_graph_snapshot", description: "Live graph snapshot: org, departments, brands, capabilities sample.", input_schema: { type: "object", properties: {}, additionalProperties: false } } as const;
export const LIST_CAPABILITIES_TOOL = { name: "list_capabilities", description: "List capability registry items, optional query filter.", input_schema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false } } as const;
export const PROPOSE_ATLAS_CAPTURE_TOOL = { name: "propose_atlas_capture", description: "Propose a knowledge capture task (HR approves).", input_schema: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"], additionalProperties: false } } as const;

export function buildAtlasTools(_role: string) {
  return [SEARCH_ATLAS_KNOWLEDGE_TOOL, RECALL_ATLAS_MEMORY_TOOL, GET_GRAPH_SNAPSHOT_TOOL, LIST_CAPABILITIES_TOOL, PROPOSE_ATLAS_CAPTURE_TOOL];
}
export const ATLAS_TOOL_NAMES = new Set([SEARCH_ATLAS_KNOWLEDGE_TOOL.name, RECALL_ATLAS_MEMORY_TOOL.name, GET_GRAPH_SNAPSHOT_TOOL.name, LIST_CAPABILITIES_TOOL.name, PROPOSE_ATLAS_CAPTURE_TOOL.name]);

export async function runAtlasTool(name: string, input: unknown, ctx: AtlasToolContext): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as ToolResult;
  try {
    switch (name) {
      case "search_atlas_knowledge": return await searchAtlasKnowledge(args);
      case "recall_atlas_memory": return await recallAtlasMemory(ctx, args);
      case "get_graph_snapshot": return await getGraphSnapshot(ctx);
      case "list_capabilities": return await listCapabilities(ctx, args);
      case "propose_atlas_capture": return await proposeAtlasCapture(ctx, args);
      default: return { error: `Unknown Atlas tool: ${name}` };
    }
  } catch (e) { return { error: e instanceof Error ? e.message : "Atlas tool failed." }; }
}
