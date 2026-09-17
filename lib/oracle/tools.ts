// lib/oracle/tools.ts — Oracle finance tools (READ + proposed).
import type { SessionProfile } from "@/lib/auth/session";
import { searchKnowledge } from "@/lib/knowledge/search";
import { writeActionAudit } from "@/lib/actions/audit";

type Shim = { from: (t: string) => any };
export type OracleToolContext = { supabase: unknown; profile: SessionProfile };
function db(ctx: OracleToolContext): Shim { return ctx.supabase as Shim; }
export type ToolResult = Record<string, unknown>;
function num(v: unknown): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
function round2(n: number){ return Math.round(n*100)/100; }
function isLeadership(ctx: OracleToolContext){ return ctx.profile.role==="ceo"||ctx.profile.role==="coo"; }

// P&L — reuse same derivation as assistant get_finance_snapshot + /finance page
async function getFinanceSnapshot(ctx: OracleToolContext, input: ToolResult): Promise<ToolResult> {
  if (!isLeadership(ctx)) return { restricted: true, message: "Finance is leadership-only (ceo/coo)." };
  const from = typeof input.from === "string" ? input.from : ""; const to = typeof input.to === "string" ? input.to : "";
  try {
    // minimal honest P&L: sum tiktok_shop_performance gmv + brand_finance + finance_entries opex
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const now = new Date();
    const defFrom = ymd(new Date(now.getFullYear(), now.getMonth()-2, 1));
    const fromStr = from || defFrom; const toStr = to || ymd(now);
    const [{data: brands}, {data: fin}, {data: metrics}, {data: entries}] = await Promise.all([
      db(ctx).from("brands").select("id, name").limit(50) as any,
      db(ctx).from("brand_finance").select("brand_id, model, cogs_pct, take_pct, retainer_monthly") as any,
      db(ctx).from("tiktok_shop_performance").select("brand_id, gmv").gte("stat_date", fromStr).lte("stat_date", toStr) as any,
      db(ctx).from("finance_entries").select("type, amount").gte("entry_date", fromStr).lte("entry_date", toStr) as any,
    ]);
    const finByBrand = new Map<string, any>(); for(const f of (fin??[]) as any[]) finByBrand.set(f.brand_id, f);
    const gmvByBrand = new Map<string, number>(); for(const m of (metrics??[]) as any[]) if(m.brand_id) gmvByBrand.set(m.brand_id, (gmvByBrand.get(m.brand_id)??0)+num(m.gmv));
    let revenue=0, cogs=0;
    for(const b of (brands??[]) as any[]){ const g=gmvByBrand.get(b.id)??0; const f=finByBrand.get(b.id); const model=f?.model==="agency"?"agency":"operator"; if(model==="agency") revenue+=(num(f?.take_pct)/100)*g+num(f?.retainer_monthly); else { revenue+=g; cogs+=(num(f?.cogs_pct)/100)*g; } }
    const opex = ((entries??[]) as any[]).filter((e)=>e.type==="opex").reduce((a,e)=>a+num(e.amount),0);
    const capex = ((entries??[]) as any[]).filter((e)=>e.type==="capex").reduce((a,e)=>a+num(e.amount),0);
    return { period:{from:fromStr,to:toStr}, currency:"PHP", revenue:round2(revenue), cogs:round2(cogs), gross_profit:round2(revenue-cogs), opex:round2(opex), operating_profit:round2(revenue-cogs-opex), capex:round2(capex), note:"Capex not subtracted from operating profit." };
  } catch(e){ return { error: e instanceof Error ? e.message : "Finance failed." }; }
}

async function getCashflowForecast(ctx: OracleToolContext): Promise<ToolResult> {
  if (!isLeadership(ctx)) return { restricted: true, message: "Cashflow is leadership-only." };
  try {
    const [{data: cashPos}, {data: entries}, {data: settlements}] = await Promise.all([
      db(ctx).from("cash_positions").select("amount, as_of_date").order("as_of_date",{ascending:false}).limit(1) as any,
      db(ctx).from("finance_entries").select("amount, entry_date, type").gte("entry_date", new Date(Date.now()-90*24*60*60*1000).toISOString().slice(0,10)) as any,
      db(ctx).from("tiktok_settlements").select("net_payout, statement_date").gte("statement_date", new Date(Date.now()-60*24*60*60*1000).toISOString().slice(0,10)) as any,
    ]);
    const anchor = (cashPos??[])[0] ?? null;
    const opexRun = ((entries??[]) as any[]).filter((e)=>e.type==="opex").reduce((a,e)=>a+num(e.amount),0);
    const inflow = ((settlements??[]) as any[]).reduce((a,s)=>a+num(s.net_payout),0);
    const runwayNote = anchor ? `Cash ${anchor.amount} as of ${anchor.as_of_date}; 90d opex ${opexRun}, 60d inflow ${inflow}. Runway = (cash + inflow - opex_rate*horizon).` : "No cash anchor — set cash position first.";
    return { anchor, opex_90d: opexRun, inflow_60d: inflow, note: runwayNote, horizons: [30,60,90] };
  } catch(e){ return { error: e instanceof Error ? e.message : "Cashflow failed." }; }
}

async function getBudgetHealth(ctx: OracleToolContext): Promise<ToolResult> {
  if (!isLeadership(ctx)) return { restricted: true, message: "Budgets are leadership-only." };
  try {
    const [{data: budgets}, {data: expenses}] = await Promise.all([
      db(ctx).from("budgets").select("brand_id, department_id, amount, period_start, period_end").limit(50) as any,
      db(ctx).from("expenses").select("brand_id, gross_amount, transaction_date").gte("transaction_date", new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10)) as any,
    ]);
    const rows = (budgets??[]) as any[];
    const spendByBrand = new Map<string,number>(); for(const e of (expenses??[]) as any[]) if(e.brand_id) spendByBrand.set(e.brand_id, (spendByBrand.get(e.brand_id)??0)+num(e.gross_amount));
    const items = rows.slice(0,10).map((b:any)=>({ brand_id:b.brand_id, amount:num(b.amount), spent: spendByBrand.get(b.brand_id)??0, util: b.amount? Math.round((spendByBrand.get(b.brand_id)??0)/num(b.amount)*100):null }));
    return { count: rows.length, items, note: items.length ? undefined : "No budgets set." };
  } catch(e){ return { error: e instanceof Error ? e.message : "Budget failed." }; }
}

async function searchFinanceKnowledge(input: ToolResult): Promise<ToolResult> {
  const q = typeof input.query === "string" ? input.query.trim() : "";
  if(!q) return { error: "Query required." };
  try{ const chunks = await searchKnowledge(q,6).catch(()=>null); if(!chunks) return {count:0,chunks:[],note:"Unavailable."}; return {count:chunks.length, chunks:chunks.map((c:any)=>({source_title:c.title, excerpt:c.content})), note:"Cite source_title."}; }catch(e){ return { error: e instanceof Error?e.message:"Search failed."}; }
}

async function proposeOracleAction(ctx: OracleToolContext, input: ToolResult): Promise<ToolResult> {
  const title = typeof input.title==="string"?input.title.trim():""; const rationale = typeof input.rationale==="string"?input.rationale.trim():"";
  if(!title) return { error: "Title required." }; if(!rationale) return { error: "Rationale required." };
  if(!isLeadership(ctx)) return { restricted: true, message: "Finance proposals are leadership-only." };
  try{
    const draft: Record<string,unknown> = { source_module:"oracle", source_ref:{by:ctx.profile.id}, title:`Oracle · ${title}`, problem:rationale, recommendation:rationale, confidence:0.6, risk_tier:1, required_role:"coo", proposed_action:{ type:"oracle_recommendation", payload:{ title, rationale } }, status:"pending" };
    const {data,error} = await (db(ctx).from("action_requests") as any).insert({org_id:ctx.profile.org_id, created_by:ctx.profile.id, status:"pending", ...draft}).select("id, title").single();
    if(error) return { error: error.message };
    const row=data as any; await writeActionAudit(db(ctx) as any,{org_id:ctx.profile.org_id, action_request_id:row.id, event:"created", actor_id:ctx.profile.id, actor_role:ctx.profile.role, detail:{source:"oracle", kind:"finance_recommendation"}});
    return { ok:true, tier:"proposed", proposed:{id:row.id, title:row.title}, message:"Filed Oracle recommendation into Approvals — pending, never moves money." };
  }catch(e){ return { error: e instanceof Error?e.message:"Could not file."}; }
}

export const GET_FINANCE_SNAPSHOT_TOOL = { name:"get_finance_snapshot", description:"P&L (leadership only): revenue, COGS, gross, opex, operating profit, capex.", input_schema:{type:"object", properties:{from:{type:"string"}, to:{type:"string"}}, additionalProperties:false}} as const;
export const GET_CASHFLOW_FORECAST_TOOL = { name:"get_cashflow_forecast", description:"Cash anchor + 90d opex + 60d inflow + runway horizons 30/60/90.", input_schema:{type:"object", properties:{}, additionalProperties:false}} as const;
export const GET_BUDGET_HEALTH_TOOL = { name:"get_budget_health", description:"Budgets vs 30d spend, utilization %.", input_schema:{type:"object", properties:{}, additionalProperties:false}} as const;
export const SEARCH_FINANCE_KNOWLEDGE_TOOL = { name:"search_finance_knowledge", description:"Search finance SOPs — cite source_title.", input_schema:{type:"object", properties:{query:{type:"string"}}, required:["query"], additionalProperties:false}} as const;
export const PROPOSE_ORACLE_ACTION_TOOL = { name:"propose_oracle_action", description:"Propose a finance recommendation (leadership, never executes).", input_schema:{type:"object", properties:{title:{type:"string"}, rationale:{type:"string"}}, required:["title","rationale"], additionalProperties:false}} as const;

export function buildOracleTools(_role: string){
  return [GET_FINANCE_SNAPSHOT_TOOL, GET_CASHFLOW_FORECAST_TOOL, GET_BUDGET_HEALTH_TOOL, SEARCH_FINANCE_KNOWLEDGE_TOOL, PROPOSE_ORACLE_ACTION_TOOL];
}
export const ORACLE_TOOL_NAMES = new Set([GET_FINANCE_SNAPSHOT_TOOL.name, GET_CASHFLOW_FORECAST_TOOL.name, GET_BUDGET_HEALTH_TOOL.name, SEARCH_FINANCE_KNOWLEDGE_TOOL.name, PROPOSE_ORACLE_ACTION_TOOL.name]);

export async function runOracleTool(name: string, input: unknown, ctx: OracleToolContext): Promise<ToolResult> {
  const args = (input && typeof input==="object"?input:{}) as ToolResult;
  try{
    switch(name){
      case "get_finance_snapshot": return await getFinanceSnapshot(ctx, args);
      case "get_cashflow_forecast": return await getCashflowForecast(ctx);
      case "get_budget_health": return await getBudgetHealth(ctx);
      case "search_finance_knowledge": return await searchFinanceKnowledge(args);
      case "propose_oracle_action": return await proposeOracleAction(ctx, args);
      default: return { error: `Unknown Oracle tool: ${name}` };
    }
  }catch(e){ return { error: e instanceof Error?e.message:"Oracle tool failed."}; }
}
