// lib/assistant/read.ts — Tony's READ tier (three memory sources).
//
// The grounded assistant answers from THREE sources, and cites which one every
// fact came from:
//   1. LIVE DATABASE  — structured, real-time rows (numbers, status, plans).
//   2. KNOWLEDGE (RAG) — uploaded company documents (SOPs, contracts) via
//      searchKnowledge() (lib/knowledge/search.ts, Brief A). Cite the doc title.
//   3. MEMORY          — durable learned facts in public.tony_memory.
//
// Tony decides which source(s) a question needs and may combine them: live DB
// for numbers ("how's Crayola?"), knowledge for documented how/what ("what's
// our returns SOP?"), memory for learned truths ("what did we decide about
// creator tiers?").
//
// SECURITY (identical contract to lib/assistant/tools.ts): every read runs on
// the caller's REQUEST-SCOPED @supabase/ssr client (ctx.supabase, via the shared
// `reader` shim), so Postgres RLS is the hard wall — org scoping and per-role
// visibility are automatic, and mini-Tony can never out-reach the signed-in
// user. No service-role key, no free-form SQL: fixed tools, typed params, the
// parameterised query builder only. The finance tool is additionally OMITTED
// from the tool list for non-leadership (buildReadTools) AND guards internally.
// On any error a tool returns { error } so the agentic loop keeps going.

import type { UserRole } from "@/types/database";
import { searchKnowledge } from "@/lib/knowledge/search";
import {
  reader,
  num,
  round2,
  resolveWindow,
  financeWindow,
  isLeadership,
  resolveBrand,
  type ToolContext,
  type ToolResult,
} from "@/lib/assistant/tools";

// --- shared row types (mirror the columns each read selects) ----------------
type MetricRow = {
  brand_id: string | null;
  platform: string | null;
  gmv: number | null;
  orders: number | null;
  units: number | null;
  returns: number | null;
};

type SnapshotRow = {
  department_id: string | null;
  efficiency: number | null;
  quality_score: number | null;
  capacity_utilization: number | null;
  gmv_impact: number | null;
  ongoing_tasks: string | null;
  expected_outputs: string | null;
  challenges: string | null;
  action_plan: string | null;
  period_start: string | null;
  period_end: string | null;
};

type BrandFinanceRow = {
  brand_id: string;
  model: string | null;
  cogs_pct: number | null;
  take_pct: number | null;
  retainer_monthly: number | null;
};

type MemoryRow = {
  category: string | null;
  content: string | null;
  pinned: boolean | null;
  updated_at: string | null;
};

type TaskRow = {
  id: string;
  title: string | null;
  status: string | null;
  priority: string | null;
  due_date: string | null;
  project_id: string | null;
  brand_id: string | null;
};

type ProjectRow = {
  id: string;
  name: string;
  status: string | null;
  due_date: string | null;
  brand_id: string | null;
  owner_id: string | null;
};

const PROJECT_STATUS_LABEL: Record<string, string> = {
  active: "Working On",
  planned: "Next",
  on_hold: "Paused",
  completed: "Done",
  archived: "Archived",
};

// ── Source 1: LIVE DATABASE ─────────────────────────────────────────────────

// get_org_pulse — the company at a glance, all live: commerce KPIs, returns,
// headcount, project counts and pending approvals. The "how are we doing right
// now" answer.
async function getOrgPulse(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const { from, to } = resolveWindow(input.from, input.to, 60);

  const [
    { data: metricData, error: metricErr },
    { data: returnData },
    { data: userData },
    { data: deptData },
    { data: projData },
    { data: approvalData },
  ] = await Promise.all([
    // Live commerce from tiktok_shop_performance (RLS-scoped) — never the retired
    // brand_platform_metrics. Summing the raw per-shop daily rows is correct for an
    // ORG total (it's a plain Σ, no per-period collapse needed). Every row is the
    // tiktok_shop channel; the by-platform split reflects that honestly.
    reader(ctx)
      .from<MetricRow>("tiktok_shop_performance")
      .select("gmv, orders, units, stat_date")
      .gte("stat_date", from)
      .lte("stat_date", to),
    reader(ctx)
      .from<{ value: number | null }>("return_cases")
      .select("value")
      .gte("reported_date", from)
      .lte("reported_date", to),
    reader(ctx)
      .from<{ id: string; department_id: string | null }>("users")
      .select("id, department_id"),
    reader(ctx).from<{ id: string; name: string }>("departments").select("id, name"),
    reader(ctx).from<{ status: string | null }>("projects").select("status"),
    reader(ctx)
      .from<{ status: string | null }>("approval_requests")
      .select("status")
      .eq("status", "pending"),
  ]);
  if (metricErr) return { error: metricErr.message };

  const byPlatform: Record<string, { gmv: number; orders: number; units: number }> = {};
  let gmv = 0;
  let orders = 0;
  let units = 0;
  for (const m of metricData ?? []) {
    const p = "tiktok_shop"; // the only live commerce channel today
    const slot = byPlatform[p] ?? (byPlatform[p] = { gmv: 0, orders: 0, units: 0 });
    slot.gmv += num(m.gmv);
    slot.orders += num(m.orders);
    slot.units += num(m.units);
    gmv += num(m.gmv);
    orders += num(m.orders);
    units += num(m.units);
  }
  for (const p of Object.keys(byPlatform)) byPlatform[p].gmv = round2(byPlatform[p].gmv);

  const returns = returnData ?? [];
  const returnValue = returns.reduce((a, r) => a + num(r.value), 0);

  const nameById = new Map((deptData ?? []).map((d) => [d.id, d.name]));
  const perDept: Record<string, number> = {};
  for (const u of userData ?? []) {
    const label = u.department_id ? nameById.get(u.department_id) ?? "Unknown" : "Unassigned";
    perDept[label] = (perDept[label] ?? 0) + 1;
  }

  const projectCounts: Record<string, number> = {};
  for (const pr of projData ?? []) {
    const s = pr.status ?? "active";
    projectCounts[s] = (projectCounts[s] ?? 0) + 1;
  }

  return {
    period: { from, to },
    currency: "PHP",
    commerce: {
      combined: { gmv: round2(gmv), orders, units },
      by_platform: byPlatform,
    },
    returns: { case_count: returns.length, total_value: round2(returnValue) },
    headcount: { total: (userData ?? []).length, by_department: perDept },
    projects: {
      working_on: projectCounts["active"] ?? 0,
      paused: projectCounts["on_hold"] ?? 0,
      next: projectCounts["planned"] ?? 0,
    },
    pending_approvals: (approvalData ?? []).length,
    note:
      (metricData ?? []).length === 0
        ? "No TikTok Shop commerce rows in this window (the live source has no data for this period)."
        : "Commerce figures are live TikTok Shop GMV (tiktok_shop_performance); Shopee/Lazada are not connected yet.",
  };
}

// get_brand_status — one brand's live state: category/status/focus, last-60-day
// GMV/orders/units/returns and return rate, and its open project count. Called
// with no brand, returns the roster so Tony can pick.
async function getBrandStatus(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const rawName = input.brand ?? input.brand_name;
  const { brand, error: brandErr } = await resolveBrand(ctx, rawName);
  if (brandErr) return { error: brandErr };

  if (!brand) {
    const { data } = await reader(ctx)
      .from<{ name: string; status: string | null }>("brands")
      .select("name, status")
      .order("name", { ascending: true });
    const roster = (data ?? []).map((b) => ({ name: b.name, status: b.status }));
    return {
      needs_brand: true,
      message: "Name a brand to get its status.",
      brands: roster,
      count: roster.length,
    };
  }

  const { from, to } = resolveWindow(input.from, input.to, 60);
  const [{ data: metricData, error }, { data: returnData }, { data: projData }] = await Promise.all([
    // Live TikTok Shop commerce (RLS-scoped), never the retired brand_platform_metrics.
    reader(ctx)
      .from<MetricRow>("tiktok_shop_performance")
      .select("gmv, orders, units, stat_date")
      .eq("brand_id", brand.id)
      .gte("stat_date", from)
      .lte("stat_date", to),
    reader(ctx)
      .from<{ value: number | null }>("return_cases")
      .select("value")
      .eq("brand_id", brand.id)
      .gte("reported_date", from)
      .lte("reported_date", to),
    reader(ctx)
      .from<{ status: string | null }>("projects")
      .select("status")
      .eq("brand_id", brand.id)
      .in("status", ["active", "on_hold", "planned"]),
  ]);
  if (error) return { error: error.message };

  let gmv = 0;
  let orders = 0;
  let units = 0;
  for (const m of metricData ?? []) {
    gmv += num(m.gmv);
    orders += num(m.orders);
    units += num(m.units);
  }
  const returnCases = returnData ?? [];
  const returnValue = returnCases.reduce((a, r) => a + num(r.value), 0);

  return {
    brand: brand.name,
    category: brand.category,
    status: brand.status,
    platform_focus: brand.platform_focus ?? [],
    gmv_share: brand.gmv_share,
    period: { from, to },
    currency: "PHP",
    performance: {
      gmv: round2(gmv),
      orders,
      units,
      // The live commerce source carries no returns count, so returns / return_rate
      // are honest nulls ("not tracked") — the real return signal is return_cases.
      returns: null,
      return_rate: null,
      return_cases: { count: returnCases.length, value: round2(returnValue) },
    },
    open_projects: (projData ?? []).length,
    note:
      (metricData ?? []).length === 0
        ? "No live TikTok Shop commerce for this brand in the window."
        : undefined,
  };
}

// get_department_plan — a department's latest metrics snapshot: the numbers plus
// the narrative plan (ongoing tasks, expected outputs, challenges, action plan)
// and its lead. Called with no department, returns the roster.
async function getDepartmentPlan(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const [{ data: deptData }, { data: userData }] = await Promise.all([
    reader(ctx)
      .from<{ id: string; name: string; lead_user_id: string | null }>("departments")
      .select("id, name, lead_user_id")
      .order("name", { ascending: true }),
    reader(ctx).from<{ id: string; full_name: string }>("users").select("id, full_name"),
  ]);
  const depts = deptData ?? [];
  const leadById = new Map((userData ?? []).map((u) => [u.id, u.full_name]));

  const raw = input.department ?? input.department_name;
  const nameArg = typeof raw === "string" ? raw.trim() : "";
  if (!nameArg) {
    return {
      needs_department: true,
      message: "Name a department to get its plan.",
      departments: depts.map((d) => d.name),
      count: depts.length,
    };
  }

  const q = nameArg.toLowerCase();
  const dept =
    depts.find((d) => (d.name ?? "").toLowerCase() === q) ??
    depts.find((d) => (d.name ?? "").toLowerCase().includes(q));
  if (!dept) return { error: `No department matching "${nameArg}".` };

  const { data: snapData, error } = await reader(ctx)
    .from<SnapshotRow>("metrics_snapshots")
    .select(
      "department_id, efficiency, quality_score, capacity_utilization, gmv_impact, ongoing_tasks, expected_outputs, challenges, action_plan, period_start, period_end"
    )
    .eq("department_id", dept.id)
    .order("period_end", { ascending: false })
    .limit(1);
  if (error) return { error: error.message };

  const s = (snapData ?? [])[0];
  if (!s) {
    return {
      department: dept.name,
      lead: dept.lead_user_id ? leadById.get(dept.lead_user_id) ?? null : null,
      note: "No metrics snapshots recorded for this department yet.",
    };
  }

  return {
    department: dept.name,
    lead: dept.lead_user_id ? leadById.get(dept.lead_user_id) ?? null : null,
    period: { start: s.period_start, end: s.period_end },
    metrics: {
      efficiency: s.efficiency,
      quality_score: s.quality_score,
      capacity_utilization: s.capacity_utilization,
      gmv_impact: s.gmv_impact,
    },
    plan: {
      ongoing_tasks: s.ongoing_tasks,
      expected_outputs: s.expected_outputs,
      challenges: s.challenges,
      action_plan: s.action_plan,
    },
  };
}

// list_my_work — the caller's OWN open work: tasks assigned to them and projects
// they own. Self-scoped (assignee_id / owner_id = the signed-in user), so this
// answers "what am I working on" for exactly this person, not the whole org.
async function listMyWork(ctx: ToolContext): Promise<ToolResult> {
  const me = ctx.profile.id;
  const [{ data: taskData, error }, { data: projData }, { data: brandData }, { data: allProj }] =
    await Promise.all([
      reader(ctx)
        .from<TaskRow>("tasks")
        .select("id, title, status, priority, due_date, project_id, brand_id")
        .eq("assignee_id", me)
        .order("due_date", { ascending: true }),
      reader(ctx)
        .from<ProjectRow>("projects")
        .select("id, name, status, due_date, brand_id, owner_id")
        .eq("owner_id", me)
        .in("status", ["active", "on_hold", "planned"])
        .order("due_date", { ascending: true }),
      reader(ctx).from<{ id: string; name: string }>("brands").select("id, name"),
      reader(ctx).from<{ id: string; name: string }>("projects").select("id, name"),
    ]);
  if (error) return { error: error.message };

  const brandById = new Map((brandData ?? []).map((b) => [b.id, b.name]));
  const projById = new Map((allProj ?? []).map((p) => [p.id, p.name]));

  // Open tasks only — done/cancelled aren't "work you're on".
  const openTasks = (taskData ?? []).filter(
    (t) => t.status !== "done" && t.status !== "cancelled"
  );
  const tasks = openTasks.map((t) => ({
    title: t.title,
    status: t.status,
    priority: t.priority,
    due_date: t.due_date,
    project: t.project_id ? projById.get(t.project_id) ?? null : null,
    brand: t.brand_id ? brandById.get(t.brand_id) ?? null : null,
  }));

  const projects = (projData ?? []).map((p) => ({
    name: p.name,
    status: PROJECT_STATUS_LABEL[p.status ?? "active"] ?? p.status,
    due_date: p.due_date,
    brand: p.brand_id ? brandById.get(p.brand_id) ?? null : null,
  }));

  return {
    for_user: ctx.profile.full_name,
    tasks: { count: tasks.length, items: tasks },
    owned_projects: { count: projects.length, items: projects },
    note:
      tasks.length === 0 && projects.length === 0
        ? "You have no open tasks or owned projects right now."
        : undefined,
  };
}

// get_finance_snapshot — company P&L (leadership only). Identical derivation to
// the Finance page: per-brand revenue/COGS by model, minus opex. RLS already
// returns nothing from the finance tables for other roles; the explicit gate +
// omission from the non-leadership tool list is belt-and-suspenders.
async function getFinanceSnapshot(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  if (!isLeadership(ctx)) {
    return {
      restricted: true,
      message: "Finance / P&L is restricted to company leadership (CEO/COO).",
    };
  }

  const { from, to } = financeWindow(input.from, input.to);
  const [{ data: brandData }, { data: finData }, { data: metricData }, { data: entryData, error }] =
    await Promise.all([
      reader(ctx).from<{ id: string; name: string }>("brands").select("id, name"),
      reader(ctx)
        .from<BrandFinanceRow>("brand_finance")
        .select("brand_id, model, cogs_pct, take_pct, retainer_monthly"),
      // Per-brand GMV from the live TikTok Shop table (RLS-scoped) — a plain Σ per
      // brand, so raw daily rows are correct here; never brand_platform_metrics.
      reader(ctx)
        .from<{ brand_id: string | null; gmv: number | null }>("tiktok_shop_performance")
        .select("brand_id, gmv")
        .gte("stat_date", from)
        .lte("stat_date", to),
      reader(ctx)
        .from<{ type: string | null; amount: number | null }>("finance_entries")
        .select("type, amount")
        .gte("entry_date", from)
        .lte("entry_date", to),
    ]);
  if (error) return { error: error.message };

  const financeByBrand = new Map<string, BrandFinanceRow>();
  for (const f of finData ?? []) financeByBrand.set(f.brand_id, f);

  const gmvByBrand = new Map<string, number>();
  for (const m of metricData ?? []) {
    if (!m.brand_id) continue;
    gmvByBrand.set(m.brand_id, (gmvByBrand.get(m.brand_id) ?? 0) + num(m.gmv));
  }

  let revenue = 0;
  let cogs = 0;
  for (const b of brandData ?? []) {
    const g = gmvByBrand.get(b.id) ?? 0;
    const f = financeByBrand.get(b.id);
    const model = f?.model === "agency" ? "agency" : "operator";
    if (model === "agency") {
      revenue += (num(f?.take_pct) / 100) * g + num(f?.retainer_monthly);
    } else {
      revenue += g;
      cogs += (num(f?.cogs_pct) / 100) * g;
    }
  }
  const grossProfit = revenue - cogs;
  const entries = entryData ?? [];
  const opex = entries.filter((e) => e.type === "opex").reduce((a, e) => a + num(e.amount), 0);
  const capex = entries.filter((e) => e.type === "capex").reduce((a, e) => a + num(e.amount), 0);

  return {
    period: { from, to },
    currency: "PHP",
    revenue: round2(revenue),
    cogs: round2(cogs),
    gross_profit: round2(grossProfit),
    opex: round2(opex),
    operating_profit: round2(grossProfit - opex),
    capex: round2(capex),
    note: "Capex is tracked separately and not subtracted from operating profit.",
  };
}

// list_automation_opportunities — LIVE DATA from the Automation Radar detector.
// Ranked repeated work (repetition_patterns) with an honest classification
// (automatable / templatable / sop / keep_human) and an estimated monthly
// time-saved figure. Optionally scoped to a department. RLS org-scopes the rows;
// the detector never fabricates — under 3 regular repetitions there's no pattern.
type RepetitionPatternRow = {
  normalized_title: string | null;
  department: string | null;
  occurrences: number | null;
  cadence: string | null;
  time_cost_per_month: number | null;
  automatability: string | null;
  suggested_path: string | null;
  matched_workflow: string | null;
  status: string | null;
};

async function listAutomationOpportunities(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const dept = typeof input.department === "string" && input.department.trim() ? input.department.trim() : null;

  let q = reader(ctx)
    .from<RepetitionPatternRow>("repetition_patterns")
    .select(
      "normalized_title, department, occurrences, cadence, time_cost_per_month, automatability, suggested_path, matched_workflow, status"
    )
    .neq("status", "dismissed")
    .order("time_cost_per_month", { ascending: false })
    .limit(25);
  if (dept) q = q.eq("department", dept);

  const { data, error } = await q;
  if (error) return { error: error.message };

  const rows = (data ?? []) as RepetitionPatternRow[];
  if (rows.length === 0) {
    return {
      filter: { department: dept ?? "all" },
      count: 0,
      opportunities: [],
      note: dept
        ? `No repetition patterns detected for ${dept} yet — under three roughly regular repetitions is "not enough signal". Do not invent any.`
        : "No repetition patterns detected yet — the detector needs at least three roughly regular repetitions. Do not invent any.",
    };
  }

  const opportunities = rows.map((r) => ({
    work: r.normalized_title,
    department: r.department,
    occurrences: r.occurrences,
    cadence: r.cadence,
    est_minutes_saved_per_month: r.time_cost_per_month,
    classification: r.automatability, // automatable | templatable | sop | keep_human
    suggested_path: r.suggested_path,
    matched_workflow: r.matched_workflow,
    status: r.status,
  }));
  const totalMinutes = rows.reduce((a, r) => a + num(r.time_cost_per_month), 0);

  return {
    filter: { department: dept ?? "all" },
    count: opportunities.length,
    total_est_minutes_saved_per_month: round2(totalMinutes),
    opportunities,
    note: "Ranked by estimated monthly time cost. Report the classification HONESTLY — 'keep_human' means it needs a person each run and must NOT be automated. Any automation you propose routes to the approval queue as pending; nothing auto-executes.",
  };
}

// ── Source 2: KNOWLEDGE (RAG) ───────────────────────────────────────────────

// search_knowledge — retrieve citable chunks from the company Knowledge Base
// (uploaded SOPs, contracts, playbooks) via searchKnowledge() (Brief A). Tony
// MUST cite the source document title. Numbers in a document are NOT live data —
// treat them as "as documented", not as current figures.
async function searchKnowledgeTool(input: ToolResult): Promise<ToolResult> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { error: "Give me something to search the knowledge base for." };

  // searchKnowledge() embeds the query and runs a permission-aware semantic
  // match; it throws (EmbeddingError) when retrieval is unavailable — e.g. no
  // OPENAI_API_KEY — so we degrade to "no results" rather than erroring the turn.
  const chunks = await searchKnowledge(query, 6).catch(() => null);
  if (!chunks) {
    return {
      count: 0,
      chunks: [],
      note: "Knowledge search is unavailable right now. Say you don't have that documented yet — do not guess.",
    };
  }
  if (chunks.length === 0) {
    return {
      count: 0,
      chunks: [],
      note: "No knowledge documents matched. Say you don't have that documented yet — do not guess.",
    };
  }
  return {
    count: chunks.length,
    chunks: chunks.map((c) => ({
      source_title: c.title,
      source_type: c.source_type,
      excerpt: c.content,
    })),
    note: "Cite the source_title when you use one of these. A figure in a document is 'as documented', not a live number.",
  };
}

// ── Source 3: MEMORY (learned facts) ────────────────────────────────────────

// recall_memory — durable, human-curated facts from public.tony_memory
// (decisions, preferences, people, processes). Filter by category and/or search
// by free-text query. Pinned facts first, then most recent.
async function recallMemory(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const category = typeof input.category === "string" && input.category.trim()
    ? input.category.trim().toLowerCase()
    : null;
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";

  let q = reader(ctx)
    .from<MemoryRow>("tony_memory")
    .select("category, content, pinned, updated_at")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(200);
  if (category) q = q.eq("category", category);
  const { data, error } = await q;
  if (error) return { error: error.message };

  let rows = (data ?? []).filter((m) => m.content);
  if (query) {
    // Client-side free-text filter: keep facts whose content or category
    // contains any query term. Keeps the DB query simple while still searching.
    const terms = query.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
    if (terms.length) {
      rows = rows.filter((m) => {
        const hay = `${m.category ?? ""} ${m.content ?? ""}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      });
    }
  }

  const memory = rows.slice(0, 40).map((m) => ({
    category: (m.category ?? "fact").toLowerCase(),
    content: m.content as string,
    pinned: !!m.pinned,
  }));

  return {
    filter: { category: category ?? "all", query: query || null },
    count: memory.length,
    memory,
    note: memory.length === 0 ? "Nothing in memory matches. Say you don't have that yet — do not guess." : undefined,
  };
}

// ── Tool definitions (Anthropic tool schema) ────────────────────────────────
const GET_ORG_PULSE_TOOL = {
  name: "get_org_pulse",
  description:
    "LIVE DATA. Company-wide pulse right now: combined + per-marketplace GMV/orders/units (default last 60 days), returns, headcount by department, project counts (working on / paused / next), and pending approvals. Use for 'how are we doing', 'company overview', 'org health'.",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date YYYY-MM-DD (optional)." },
      to: { type: "string", description: "End date YYYY-MM-DD (optional)." },
    },
    additionalProperties: false,
  },
} as const;

const GET_BRAND_STATUS_TOOL = {
  name: "get_brand_status",
  description:
    "LIVE DATA. One brand's current status and numbers: category, status, marketplace focus, GMV share, plus last-60-day GMV/orders/units/returns, return rate and open project count. Use for 'how's Crayola?', 'status of brand X'. Call with no brand to list the roster.",
  input_schema: {
    type: "object",
    properties: {
      brand: { type: "string", description: "Brand/client name (case-insensitive). Omit to list all brands." },
      from: { type: "string", description: "Start date YYYY-MM-DD (optional)." },
      to: { type: "string", description: "End date YYYY-MM-DD (optional)." },
    },
    additionalProperties: false,
  },
} as const;

const GET_DEPARTMENT_PLAN_TOOL = {
  name: "get_department_plan",
  description:
    "LIVE DATA. A department's latest snapshot: efficiency, quality, capacity, GMV impact, plus the narrative plan (ongoing tasks, expected outputs, challenges, action plan) and its lead. Use for 'what's the plan for E-Commerce Ops', 'how's the Creative team doing'. Call with no department to list them.",
  input_schema: {
    type: "object",
    properties: {
      department: { type: "string", description: "Department name (case-insensitive). Omit to list all departments." },
    },
    additionalProperties: false,
  },
} as const;

const LIST_MY_WORK_TOOL = {
  name: "list_my_work",
  description:
    "LIVE DATA. YOUR own open work: tasks assigned to you (title, status, priority, due date, project, brand) and projects you own. Self-scoped to the signed-in user only. Use for 'what am I working on', 'what's on my plate', 'my tasks'.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
} as const;

const GET_FINANCE_SNAPSHOT_TOOL = {
  name: "get_finance_snapshot",
  description:
    "LIVE DATA (leadership only). Company P&L (default: start of two months ago → today): revenue, COGS, gross profit, opex, operating profit, capex. Use for 'how's our P&L', 'are we profitable'.",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start date YYYY-MM-DD (optional)." },
      to: { type: "string", description: "End date YYYY-MM-DD (optional)." },
    },
    additionalProperties: false,
  },
} as const;

const LIST_AUTOMATION_OPPORTUNITIES_TOOL = {
  name: "list_automation_opportunities",
  description:
    "LIVE DATA. Automation Radar: repeated work mined from real tasks, ranked by estimated monthly time cost, each with an honest classification (automatable = a live capability/workflow exists; templatable = a recurring template fits; sop = write an SOP; keep_human = needs judgment each run, never automate) and its suggested next step. Use for 'what should we automate', 'where are we wasting time', 'automation opportunities'. Optionally scope to a department.",
  input_schema: {
    type: "object",
    properties: {
      department: {
        type: "string",
        description: "Department name to scope to (e.g. 'Creative', 'E-Commerce Ops'). Omit for org-wide.",
      },
    },
    additionalProperties: false,
  },
} as const;

const SEARCH_KNOWLEDGE_TOOL = {
  name: "search_knowledge",
  description:
    "KNOWLEDGE BASE (documents). Search uploaded company documents — SOPs, contracts, playbooks — and get citable text excerpts with their source document title. Use for documented how/what: 'what's our returns SOP', 'what does the brand X contract say', 'our onboarding process'. Always cite the source document title. A figure in a document is 'as documented', never a live number.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up in the company documents." },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

const RECALL_MEMORY_TOOL = {
  name: "recall_memory",
  description:
    "MEMORY (learned facts). Durable, human-curated facts about the org — decisions made, preferences, people, processes — from Tony Memory. Filter by category and/or search by query. Pinned facts first. Use for 'what did we decide about creator tiers', 'what do you remember about…'.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text to search remembered facts (optional)." },
      category: { type: "string", description: "Category filter, e.g. decision, fact, preference, person (optional)." },
    },
    additionalProperties: false,
  },
} as const;

// The READ tier offered to a given role. The finance snapshot is OMITTED for
// non-leadership (RLS is the hard wall; omission means mini-Tony isn't even told
// it exists) — everything else is available to every signed-in role, RLS-scoped.
export function buildReadTools(role: UserRole) {
  const tools: Array<
    | typeof GET_ORG_PULSE_TOOL
    | typeof GET_BRAND_STATUS_TOOL
    | typeof GET_DEPARTMENT_PLAN_TOOL
    | typeof LIST_MY_WORK_TOOL
    | typeof GET_FINANCE_SNAPSHOT_TOOL
    | typeof LIST_AUTOMATION_OPPORTUNITIES_TOOL
    | typeof SEARCH_KNOWLEDGE_TOOL
    | typeof RECALL_MEMORY_TOOL
  > = [
    GET_ORG_PULSE_TOOL,
    GET_BRAND_STATUS_TOOL,
    GET_DEPARTMENT_PLAN_TOOL,
    LIST_MY_WORK_TOOL,
    LIST_AUTOMATION_OPPORTUNITIES_TOOL,
    SEARCH_KNOWLEDGE_TOOL,
    RECALL_MEMORY_TOOL,
  ];
  if (role === "ceo" || role === "coo") tools.push(GET_FINANCE_SNAPSHOT_TOOL);
  return tools;
}

export const READ_TOOL_NAMES: Set<string> = new Set([
  GET_ORG_PULSE_TOOL.name,
  GET_BRAND_STATUS_TOOL.name,
  GET_DEPARTMENT_PLAN_TOOL.name,
  LIST_MY_WORK_TOOL.name,
  GET_FINANCE_SNAPSHOT_TOOL.name,
  LIST_AUTOMATION_OPPORTUNITIES_TOOL.name,
  SEARCH_KNOWLEDGE_TOOL.name,
  RECALL_MEMORY_TOOL.name,
]);

// ── Dispatch ────────────────────────────────────────────────────────────────
// Runs one READ tool. Never throws: any failure becomes { error } so the agentic
// loop continues and the model can explain the gap.
export async function runAssistantReadTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as ToolResult;
  try {
    switch (name) {
      case "get_org_pulse":
        return await getOrgPulse(ctx, args);
      case "get_brand_status":
        return await getBrandStatus(ctx, args);
      case "get_department_plan":
        return await getDepartmentPlan(ctx, args);
      case "list_my_work":
        return await listMyWork(ctx);
      case "get_finance_snapshot":
        return await getFinanceSnapshot(ctx, args);
      case "list_automation_opportunities":
        return await listAutomationOpportunities(ctx, args);
      case "search_knowledge":
        return await searchKnowledgeTool(args);
      case "recall_memory":
        return await recallMemory(ctx, args);
      default:
        return { error: `Unknown read tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Read tool failed." };
  }
}

// ── System-prompt block ───────────────────────────────────────────────────────
// The READ tier contract: three sources, always grounded, always cited. Appended
// to the system prompt so the honesty + citation rules travel with the tools.
// Finance is named only for leadership (it's not in their tool list otherwise).
export function buildReadPrompt(role: UserRole): string {
  const leadership = role === "ceo" || role === "coo";
  const lines: string[] = [
    "=== Reading (answer from three memory sources, always cited) ===",
    "You retrieve from THREE sources and you decide which one(s) a question needs —",
    "you may combine them:",
    "",
    "1. LIVE DATABASE — real-time numbers and status. Tools: get_org_pulse,",
    "   get_brand_status, get_department_plan, list_my_work," +
      " list_automation_opportunities" +
      (leadership ? ", get_finance_snapshot" : "") +
      ". Use for numbers/status ('how's Crayola?', 'what am I working on',",
    "   'what should we automate?'). For automation questions call",
    "   list_automation_opportunities and report the classification HONESTLY —",
    "   'keep_human' must NOT be automated; any automation you propose is queued",
    "   as a pending approval, never auto-run.",
    "2. KNOWLEDGE BASE — documented how/what in uploaded company documents.",
    "   Tool: search_knowledge. Use for 'what's our returns SOP', 'what does the",
    "   brand X contract say'. ALWAYS cite the source document title.",
    "3. MEMORY — durable learned facts/decisions. Tool: recall_memory. Use for",
    "   'what did we decide about…', 'what do you remember about…'.",
    "",
    "GROUNDING + CITATION (non-negotiable):",
    "- Prefix every fact with where it came from: \"From live data …\", \"From the",
    "  <document title> …\", or \"From memory …\". Never state a fact without its origin.",
    "- NUMBERS come ONLY from the live database. Never quote a figure from a document",
    "  or a memory as if it were current — a document figure is 'as documented'.",
    "- If retrieval comes back empty, say \"I don't have that yet\" (or \"…not documented",
    "  yet\"). NEVER fabricate, estimate, or fill a gap with a plausible-sounding answer.",
  ];
  return lines.join("\n");
}
