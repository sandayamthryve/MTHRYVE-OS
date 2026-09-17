// lib/prospector/tools.ts — Prospector opportunity tools (READ + proposed).
import type { SessionProfile } from "@/lib/auth/session";
import { searchKnowledge } from "@/lib/knowledge/search";
import { writeActionAudit } from "@/lib/actions/audit";

type Shim = { from:(t:string)=>any };
export type ProspectorToolContext = { supabase: unknown; profile: SessionProfile };
function db(ctx: ProspectorToolContext): Shim { return ctx.supabase as Shim; }
export type ToolResult = Record<string, unknown>;
function str(v: unknown){ return typeof v==="string"?v.trim():""; }

async function listProspectQueue(ctx: ProspectorToolContext): Promise<ToolResult> {
  try{
    const {data, error} = await db(ctx).from("action_requests").select("title, status, created_at").eq("status","pending").in("source_module",["opportunity","bizdev"]).order("created_at",{ascending:false}).limit(10) as any;
    if(error) return { error: error.message };
    return { count:(data??[]).length, items: data??[], note:(data??[]).length?"Pending prospect tasks.":"No pending prospect tasks." };
  }catch(e){ return { error: e instanceof Error?e.message:"Queue failed."}; }
}

async function getProspectContext(ctx: ProspectorToolContext, input: ToolResult): Promise<ToolResult> {
  const name = str(input.name).toLowerCase(); if(!name) return { error:"Name required." };
  try{
    const [{data: leads},{data: tasks}] = await Promise.all([
      db(ctx).from("leads").select("id, name, stage, source, notes").ilike("name",`%${name}%`) as any,
      db(ctx).from("tasks").select("id, title, status").ilike("title",`%${name}%`) as any,
    ]);
    const lead=(leads??[])[0]; if(lead) return { kind:"lead", item: lead };
    const task=(tasks??[])[0]; if(task) return { kind:"task", item: task };
    return { error: `No prospect "${input.name}" in leads or tasks.` };
  }catch(e){ return { error: e instanceof Error?e.message:"Lookup failed."}; }
}

async function findProspects(ctx: ProspectorToolContext, input: ToolResult): Promise<ToolResult> {
  const raw = typeof input.candidates === "string" ? input.candidates.trim() : "";
  if(!raw) return { error:"Provide candidates as CSV: name, category, monthly_revenue ..." };
  try{
    const { data: reg } = await db(ctx).from("automation_registry").select("webhook_url, enabled").eq("key","opportunity_engine").maybeSingle() as any;
    const webhook = (reg as any)?.webhook_url ?? null;
    const enabled = (reg as any)?.enabled ?? false;
    if(!webhook || !enabled){
      const lines = raw.split("\n").slice(1,6).map((l)=>l.split(",")[0]?.trim()).filter(Boolean);
      return { stub:true, count: lines.length, ranked: lines.map((n,i)=>({name:n, tier: i===0?"HOT":"WARM", score: 80-i*10, reason: "Webhook not configured — stub ranking. Configure opportunity_engine in automation_registry for real scoring."})), note:"Configure opportunity_engine webhook for real HOT/WARM/COLD scoring." };
    }
    try{
      const { callOpportunityEngine } = await import("@/lib/opportunities/engine");
      const { parseOpportunityCsv } = await import("@/lib/opportunities/csv");
      const parsed = parseOpportunityCsv(raw);
      const candidates = parsed.candidates;
      const res = await callOpportunityEngine(webhook, { criteria: { focus_category: null, min_monthly_revenue: null, prioritize: { sells_online: false, has_tiktok_shop: false, gmv_declining: false, runs_ads: false } }, candidates });
      if (!res.ok) return { error: res.error ?? "Engine failed.", webhook, count: 0 };
      return { count: res.results.length, ranked: res.results, note: res.results.length ? undefined : "Engine returned no ranked results." };
    }catch(e){
      return { error: e instanceof Error?e.message:"Engine call failed.", webhook };
    }
  }catch(e){ return { error: e instanceof Error?e.message:"Find failed."}; }
}

async function searchProspectKnowledge(input: ToolResult): Promise<ToolResult> {
  const q=str(input.query); if(!q) return { error:"Query required."};
  try{ const chunks=await searchKnowledge(q,6).catch(()=>null); if(!chunks) return {count:0,chunks:[],note:"Unavailable."}; return {count:chunks.length, chunks:chunks.map((c:any)=>({source_title:c.title, excerpt:c.content})), note:"Cite source_title."}; }catch(e){ return { error: e instanceof Error?e.message:"Search failed."}; }
}

async function proposeProspectTask(ctx: ProspectorToolContext, input: ToolResult): Promise<ToolResult> {
  const name = str(input.name); const tier = str(input.tier) || "HOT"; const reason = str(input.reason) || "Prospect qualified for review.";
  if(!name) return { error:"Prospect name required." };
  const canPropose = ctx.profile.role==="ceo"||ctx.profile.role==="coo"||ctx.profile.role==="department_head";
  if(!canPropose) return { routed:true, message:"You can't file prospect tasks — flag for BizDev/leadership." };
  try{
    const draft: Record<string,unknown> = {
      source_module:"opportunity",
      source_ref:{prospect: name, by: ctx.profile.id},
      title:`Prospect · ${name} — ${tier}`,
      problem: reason,
      recommendation: `Qualify ${name} (${tier}): ${reason}`,
      confidence: tier==="HOT"?0.85:0.6,
      risk_tier: 1,
      required_role:"department_head",
      proposed_action:{type:"create_opportunity_task", payload:{candidate_name: name, tier, reason}},
      status:"pending",
    };
    const {data, error} = await (db(ctx).from("action_requests") as any).insert({org_id:ctx.profile.org_id, created_by:ctx.profile.id, status:"pending", ...draft}).select("id, title").single();
    if(error) return { routed:true, message:"No permission — flag for BizDev.", detail:error.message };
    const row=data as any; await writeActionAudit(db(ctx) as any,{org_id:ctx.profile.org_id, action_request_id:row.id, event:"created", actor_id:ctx.profile.id, actor_role:ctx.profile.role, detail:{source:"prospector", kind:"opportunity_task"}});
    return { ok:true, tier:"proposed", proposed:{id:row.id, title:row.title}, message:`Filed Prospector task for ${name} into Approvals as pending — BizDev approves.` };
  }catch(e){ return { error: e instanceof Error?e.message:"Could not file."}; }
}

export const LIST_PROSPECT_QUEUE_TOOL = { name:"list_prospect_queue", description:"Pending prospect tasks/leads in Approvals.", input_schema:{type:"object", properties:{}, additionalProperties:false}} as const;
export const GET_PROSPECT_CONTEXT_TOOL = { name:"get_prospect_context", description:"Prospect context by name (lead or task).", input_schema:{type:"object", properties:{name:{type:"string"}}, required:["name"], additionalProperties:false}} as const;
export const FIND_PROSPECTS_TOOL = { name:"find_prospects", description:"Score candidates CSV via opportunity_engine webhook (stub if not configured).", input_schema:{type:"object", properties:{candidates:{type:"string", description:"CSV: name, category, monthly_revenue,..."}}, required:["candidates"], additionalProperties:false}} as const;
export const SEARCH_PROSPECT_KNOWLEDGE_TOOL = { name:"search_prospect_knowledge", description:"Search BizDev SOPs — cite source_title.", input_schema:{type:"object", properties:{query:{type:"string"}}, required:["query"], additionalProperties:false}} as const;
export const PROPOSE_PROSPECT_TASK_TOOL = { name:"propose_prospect_task", description:"File a pending qualification task (BizDev approves).", input_schema:{type:"object", properties:{name:{type:"string"}, tier:{type:"string", enum:["HOT","WARM","COLD"]}, reason:{type:"string"}}, required:["name"], additionalProperties:false}} as const;

export function buildProspectorTools(_role: string){
  return [LIST_PROSPECT_QUEUE_TOOL, GET_PROSPECT_CONTEXT_TOOL, FIND_PROSPECTS_TOOL, SEARCH_PROSPECT_KNOWLEDGE_TOOL, PROPOSE_PROSPECT_TASK_TOOL];
}
export const PROSPECTOR_TOOL_NAMES = new Set([LIST_PROSPECT_QUEUE_TOOL.name, GET_PROSPECT_CONTEXT_TOOL.name, FIND_PROSPECTS_TOOL.name, SEARCH_PROSPECT_KNOWLEDGE_TOOL.name, PROPOSE_PROSPECT_TASK_TOOL.name]);

export async function runProspectorTool(name: string, input: unknown, ctx: ProspectorToolContext): Promise<ToolResult> {
  const args=(input&&typeof input==="object"?input:{}) as ToolResult;
  try{
    switch(name){
      case "list_prospect_queue": return await listProspectQueue(ctx);
      case "get_prospect_context": return await getProspectContext(ctx, args);
      case "find_prospects": return await findProspects(ctx, args);
      case "search_prospect_knowledge": return await searchProspectKnowledge(args);
      case "propose_prospect_task": return await proposeProspectTask(ctx, args);
      default: return { error: `Unknown Prospector tool: ${name}` };
    }
  }catch(e){ return { error: e instanceof Error?e.message:"Prospector tool failed."}; }
}
