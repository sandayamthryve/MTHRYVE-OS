// lib/herald/tools.ts — Herald outreach tools (READ + proposed).
import type { SessionProfile } from "@/lib/auth/session";
import { searchKnowledge } from "@/lib/knowledge/search";
import { writeActionAudit } from "@/lib/actions/audit";
import { buildLeadFollowUpDraft, buildCreatorFollowUpDraft } from "@/lib/actions/follow-ups";

type Shim = { from:(t:string)=>any };
export type HeraldToolContext = { supabase: unknown; profile: SessionProfile };
function db(ctx: HeraldToolContext): Shim { return ctx.supabase as Shim; }
export type ToolResult = Record<string, unknown>;
function str(v: unknown){ return typeof v==="string"?v.trim():""; }

async function listOutreachQueue(ctx: HeraldToolContext): Promise<ToolResult> {
  try{
    const { data, error } = await db(ctx).from("action_requests").select("title, status, created_at").eq("status","pending").in("source_module",["bizdev","affiliate","care"]).order("created_at",{ascending:false}).limit(10) as any;
    if(error) return { error: error.message };
    return { count: (data??[]).length, items: data??[], note: (data??[]).length?"Pending follow-ups.":"No pending outreach." };
  }catch(e){ return { error: e instanceof Error?e.message:"Queue failed."}; }
}

async function getOutreachTarget(ctx: HeraldToolContext, input: ToolResult): Promise<ToolResult> {
  const name = str(input.name).toLowerCase();
  if(!name) return { error: "Name required." };
  try{
    const [{data: leads},{data: creators}] = await Promise.all([
      db(ctx).from("leads").select("id, name, company, stage, owner_id, next_action_date").ilike("name",`%${name}%`) as any,
      db(ctx).from("creators").select("id, name, handle, platform, outreach_stage, owner_id").ilike("name",`%${name}%`) as any,
    ]);
    const lead = (leads??[])[0]; const creator = (creators??[])[0];
    if(lead) return { kind:"lead", item: lead };
    if(creator) return { kind:"creator", item: creator };
    return { error: `No lead or creator matching "${input.name}".` };
  }catch(e){ return { error: e instanceof Error?e.message:"Lookup failed."}; }
}

async function searchOutreachKnowledge(input: ToolResult): Promise<ToolResult> {
  const q = str(input.query); if(!q) return { error: "Query required." };
  try{ const chunks = await searchKnowledge(q,6).catch(()=>null); if(!chunks) return {count:0,chunks:[],note:"Unavailable."}; return {count:chunks.length, chunks:chunks.map((c:any)=>({source_title:c.title, excerpt:c.content})), note:"Cite source_title."}; }catch(e){ return { error: e instanceof Error?e.message:"Search failed."}; }
}

async function draftHeraldMessage(ctx: HeraldToolContext, input: ToolResult): Promise<ToolResult> {
  const target = str(input.target); if(!target) return { error: "Target name required." };
  const q = target.toLowerCase();
  try{
    const [{data: leads},{data: creators}] = await Promise.all([
      db(ctx).from("leads").select("id, name, company, stage, value").ilike("name",`%${q}%`) as any,
      db(ctx).from("creators").select("id, name, handle, platform, follower_count, category, outreach_stage").ilike("name",`%${q}%`) as any,
    ]);
    const lead = (leads??[]).find((l:any)=>(l.name??"").toLowerCase()===q) ?? (leads??[])[0];
    if(lead){ const draft = buildLeadFollowUpDraft(lead as any); return { kind:"lead", draft, note:"Draft staged — propose_herald_send to file for approval." }; }
    const creator = (creators??[]).find((c:any)=>(c.name??"").toLowerCase()===q) ?? (creators??[])[0];
    if(creator){ const draft = buildCreatorFollowUpDraft(creator as any); return { kind:"creator", draft, note:"Draft staged — propose_herald_send." }; }
    return { error: `No lead or creator "${target}"` };
  }catch(e){ return { error: e instanceof Error?e.message:"Draft failed."}; }
}

async function proposeHeraldSend(ctx: HeraldToolContext, input: ToolResult): Promise<ToolResult> {
  const target = str(input.target); const channel = str(input.channel) || "email"; const message = str(input.message);
  if(!target) return { error: "Target required." }; if(!message) return { error: "Message required." };
  const canPropose = ctx.profile.role==="ceo"||ctx.profile.role==="coo"||ctx.profile.role==="department_head";
  if(!canPropose) return { routed:true, message:"You can't file sends — flag for leadership." };
  try{
    // Resolve lead vs creator
    const q = target.toLowerCase();
    const [{data: leads},{data: creators}] = await Promise.all([
      db(ctx).from("leads").select("id, name").ilike("name",`%${q}%`) as any,
      db(ctx).from("creators").select("id, name").ilike("name",`%${q}%`) as any,
    ]);
    const lead = (leads??[]).find((l:any)=>(l.name??"").toLowerCase()===q) ?? (leads??[])[0];
    const creator = (creators??[]).find((c:any)=>(c.name??"").toLowerCase()===q) ?? (creators??[])[0];
    const payload: Record<string,unknown> = { channel, drafted_message: message, lead_id: lead?.id ?? null, creator_id: lead?null:creator?.id ?? null };
    if(!payload.lead_id && !payload.creator_id) return { error: `No lead or creator "${target}"` };
    const draft: Record<string,unknown> = {
      source_module: lead?"bizdev":"affiliate",
      source_ref: lead?{lead_id: lead.id}:{creator_id: creator.id},
      title: `Herald send · ${target} — ${channel}`,
      problem: `Drafted ${channel} for ${target}`,
      recommendation: message,
      confidence: 0.6,
      risk_tier: 1,
      required_role: "department_head",
      proposed_action: { type: "log_followup", payload },
      status:"pending",
    };
    const {data,error} = await (db(ctx).from("action_requests") as any).insert({org_id:ctx.profile.org_id, created_by:ctx.profile.id, status:"pending", ...draft}).select("id, title").single();
    if(error) return { routed:true, message:"No permission — flag for leadership.", detail:error.message };
    const row=data as any; await writeActionAudit(db(ctx) as any,{org_id:ctx.profile.org_id, action_request_id:row.id, event:"created", actor_id:ctx.profile.id, actor_role:ctx.profile.role, detail:{source:"herald", kind:"send", channel}});
    return { ok:true, tier:"proposed", proposed:{id:row.id, title:row.title}, message: `Filed Herald ${channel} for ${target} into Approvals as pending — human approves before it logs.` };
  }catch(e){ return { error: e instanceof Error?e.message:"Could not file."}; }
}

export const LIST_OUTREACH_QUEUE_TOOL = { name:"list_outreach_queue", description:"Pending BizDev/affiliate follow-ups.", input_schema:{type:"object", properties:{}, additionalProperties:false}} as const;
export const GET_OUTREACH_TARGET_TOOL = { name:"get_outreach_target", description:"Lead or creator by name.", input_schema:{type:"object", properties:{name:{type:"string"}}, required:["name"], additionalProperties:false}} as const;
export const SEARCH_OUTREACH_KNOWLEDGE_TOOL = { name:"search_outreach_knowledge", description:"Search outreach SOPs — cite source_title.", input_schema:{type:"object", properties:{query:{type:"string"}}, required:["query"], additionalProperties:false}} as const;
export const DRAFT_HERALD_MESSAGE_TOOL = { name:"draft_herald_message", description:"Draft a follow-up message for a lead/creator (no send).", input_schema:{type:"object", properties:{target:{type:"string"}}, required:["target"], additionalProperties:false}} as const;
export const PROPOSE_HERALD_SEND_TOOL = { name:"propose_herald_send", description:"File a pending send into Approvals (leadership approves).", input_schema:{type:"object", properties:{target:{type:"string"}, channel:{type:"string", enum:["email","message"]}, message:{type:"string"}}, required:["target","message"], additionalProperties:false}} as const;

export function buildHeraldTools(_role: string){
  return [LIST_OUTREACH_QUEUE_TOOL, GET_OUTREACH_TARGET_TOOL, SEARCH_OUTREACH_KNOWLEDGE_TOOL, DRAFT_HERALD_MESSAGE_TOOL, PROPOSE_HERALD_SEND_TOOL];
}
export const HERALD_TOOL_NAMES = new Set([LIST_OUTREACH_QUEUE_TOOL.name, GET_OUTREACH_TARGET_TOOL.name, SEARCH_OUTREACH_KNOWLEDGE_TOOL.name, DRAFT_HERALD_MESSAGE_TOOL.name, PROPOSE_HERALD_SEND_TOOL.name]);

export async function runHeraldTool(name: string, input: unknown, ctx: HeraldToolContext): Promise<ToolResult> {
  const args=(input&&typeof input==="object"?input:{}) as ToolResult;
  try{
    switch(name){
      case "list_outreach_queue": return await listOutreachQueue(ctx);
      case "get_outreach_target": return await getOutreachTarget(ctx, args);
      case "search_outreach_knowledge": return await searchOutreachKnowledge(args);
      case "draft_herald_message": return await draftHeraldMessage(ctx, args);
      case "propose_herald_send": return await proposeHeraldSend(ctx, args);
      default: return { error: `Unknown Herald tool: ${name}` };
    }
  }catch(e){ return { error: e instanceof Error?e.message:"Herald tool failed."}; }
}
