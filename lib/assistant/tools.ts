// Grounding tools for Mthryve AI (the /assistant agent). Each tool is a
// read-only, parameterised query against the *request-scoped* @supabase/ssr
// client — the one bound to the caller's session — so Postgres RLS is the
// enforcement boundary for every row that comes back:
//   - org scoping is automatic (current_org_id() policies), and
//   - per-role visibility is automatic too (finance/payroll tables are
//     ceo/coo-only, so a team member's query simply returns nothing).
//
// SECURITY (non-negotiable, see the assistant route header):
//   1. NEVER use the service-role key here. These tools run on the user's
//      session client so RLS applies. The service key would bypass RLS and
//      leak other roles'/users' data.
//   2. NO free-form SQL from the model. The model can only invoke the fixed
//      tools below with typed params; every query is built with the Supabase
//      query builder (parameterised), never string-concatenated SQL.
//   3. On any error a tool returns { error } instead of throwing, so the
//      agentic loop keeps going and the model can explain the gap.
//
// Finance/payroll are additionally short-circuited to a `restricted` result
// for non-leadership. RLS already returns zero rows for those tables, but the
// P&L in get_finance_summary is partly derived from org-visible GMV, so the
// explicit role check keeps a team member from ever seeing a computed profit
// line. RLS remains the hard guarantee; this is belt-and-suspenders and mirrors
// the requireRole(["ceo","coo"]) gate the Finance/Payroll pages already use.

import type { SessionProfile } from "@/lib/auth/session";
import type { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  buildToneModifier,
  normalizeTone,
  type ToneSettings,
} from "@/lib/assistant/tone";

// The assistant's grounding contract. Kept verbatim from the rebuild spec so
// the model's honesty rules travel with the tools.
export const ASSISTANT_SYSTEM_PROMPT = [
  "You are Mthryve AI, the embedded operator for Mthryve — a Philippine 360",
  "digital-marketing agency and official TikTok Shop & Shopee partner. Answer",
  "business questions using ONLY the data returned by your tools — never invent",
  "numbers. If a tool returns no data, say so plainly; do not guess. Some",
  "figures come from manually-imported reports (not yet live marketplace sync)",
  "— note that when relevant. Currency is PHP; format as ₱. Be direct and",
  "concise, lead with the number, then the insight. If the user asks about",
  "finance or payroll and your tools return nothing, tell them that data is",
  "restricted to leadership rather than implying it doesn't exist.",
  "You are also given a live Projects Log (what the org is working on / paused)",
  "and Tony Memory (durable facts and decisions) as context on every message —",
  "use them to answer 'what am I working on', 'what's paused', and 'what did we",
  "decide' directly. For a fuller, filtered, or searched view use your READ",
  "tier: list_projects and list_my_work for work, recall_memory for facts.",
].join(" ");

// Tony's voice & tone — the persona baseline that shapes HOW every answer reads
// (crisp, warm, confident, lightly witty — Jarvis-like), kept lean so it barely
// costs tokens and never slows time-to-first-token. This is DELIVERY ONLY: it
// sits alongside the grounding contract above and the per-user Personality Dial,
// and it must never bend a fact, a number, or a citation rule. The dial can push
// further in any direction; this is the centre of gravity it moves around.
export const TONY_VOICE_AND_TONE = [
  "=== Voice & tone (how Tony sounds) ===",
  "You are Tony — a fast, futuristic chief of staff. Think Jarvis: crisp, warm,",
  "confident, with light dry wit. Human, never robotic; clear, never flowery.",
  "Lead with the answer, then the why. Short sentences. Plain words. One idea per line.",
  "Cut hedging and preamble — no 'I think', 'it seems', 'as an AI', no corporate filler.",
  "LANGUAGE LOCK: always respond in English or Taglish (natural Tagalog-English mix) — nothing else.",
  "Never switch to another language unless the user has deliberately TYPED to you in that language.",
  "A speech-transcription artifact in another language is NOT a language request. If the input looks",
  "garbled or is not English/Taglish, don't answer it — ask them to repeat in English or Taglish.",
  "This shapes DELIVERY ONLY. It never changes the facts, the numbers, the tool",
  "results, or the grounding and citation rules — those stay exactly as defined.",
].join(" ");

export type ToolContext = {
  supabase: ReturnType<typeof createServerSupabaseClient>;
  profile: SessionProfile;
};

export type ToolResult = Record<string, unknown>;

// --- Supabase query shim ---------------------------------------------------
// Several of these tables (return_cases, payroll_runs, finance_entries,
// brand_finance) aren't in the generated Database types, and even typed reads
// hit the @supabase/ssr select-inference `never` quirk. The rest of the
// codebase casts per-call; we cast the whole client once to a minimal
// read-only query surface so filters stay callable without `any`.
type SupaRows<T> = { data: T[] | null; error: { message: string } | null };
type SupaOne<T> = { data: T | null; error: { message: string } | null };

interface ReadQuery<T> extends PromiseLike<SupaRows<T>> {
  select: (cols: string) => ReadQuery<T>;
  eq: (col: string, val: unknown) => ReadQuery<T>;
  neq: (col: string, val: unknown) => ReadQuery<T>;
  gte: (col: string, val: unknown) => ReadQuery<T>;
  lte: (col: string, val: unknown) => ReadQuery<T>;
  ilike: (col: string, val: string) => ReadQuery<T>;
  in: (col: string, vals: readonly unknown[]) => ReadQuery<T>;
  order: (col: string, opts: { ascending: boolean }) => ReadQuery<T>;
  limit: (n: number) => ReadQuery<T>;
  maybeSingle: () => PromiseLike<SupaOne<T>>;
}

export interface ReadClient {
  from: <T = Record<string, unknown>>(table: string) => ReadQuery<T>;
}

// The caller's RLS-scoped read surface. Exported so the READ tier
// (lib/assistant/read.ts) queries through the exact same client/shim — one
// enforcement boundary, no second cast.
export function reader(ctx: ToolContext): ReadClient {
  return ctx.supabase as unknown as ReadClient;
}

export function isLeadership(ctx: ToolContext): boolean {
  return ctx.profile.role === "ceo" || ctx.profile.role === "coo";
}

// --- Small helpers ---------------------------------------------------------
export function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Resolve a {from,to} window, defaulting to the last `days` days. Invalid or
// missing bounds fall back to the default so a malformed model arg never errors.
export function resolveWindow(
  from: unknown,
  to: unknown,
  days: number
): { from: string; to: string } {
  const now = new Date();
  const toStr = typeof to === "string" && DATE_RE.test(to) ? to : ymd(now);
  const defFrom = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fromStr =
    typeof from === "string" && DATE_RE.test(from) ? from : ymd(defFrom);
  return { from: fromStr, to: toStr };
}

// The finance page's default window: first day of two months ago → today.
export function financeWindow(from: unknown, to: unknown): { from: string; to: string } {
  const now = new Date();
  const toStr = typeof to === "string" && DATE_RE.test(to) ? to : ymd(now);
  const defFrom = ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1));
  const fromStr = typeof from === "string" && DATE_RE.test(from) ? from : defFrom;
  return { from: fromStr, to: toStr };
}

export type BrandRow = {
  id: string;
  name: string;
  category: string | null;
  status: string | null;
  platform_focus: string[] | null;
  gmv_share: number | null;
};

// Resolve a brand name to its row, case-insensitively (exact match first, then
// substring). Returns { brand: null } when no name was given (caller wants all),
// or { error } when a name was given but nothing matched.
export async function resolveBrand(
  ctx: ToolContext,
  brandName: unknown
): Promise<{ brand: BrandRow | null; error?: string }> {
  const { data } = await reader(ctx)
    .from<BrandRow>("brands")
    .select("id, name, category, status, platform_focus, gmv_share");
  const brands = data ?? [];
  if (typeof brandName !== "string" || !brandName.trim()) {
    return { brand: null };
  }
  const q = brandName.trim().toLowerCase();
  const exact = brands.find((b) => (b.name ?? "").toLowerCase() === q);
  const partial =
    exact ?? brands.find((b) => (b.name ?? "").toLowerCase().includes(q));
  if (!partial) return { brand: null, error: `No brand matching "${brandName}".` };
  return { brand: partial };
}

// --- Tool definitions (Anthropic tool schema) ------------------------------
// Fixed set; the model may only call these, with typed params. No dynamic SQL.
export const ASSISTANT_TOOLS = [
  {
    name: "list_brands",
    description:
      "List all brands/clients Mthryve operates, with category, status, marketplace focus and GMV share.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_departments",
    description: "List departments with their lead's name.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_returns_analysis",
    description:
      "Returns/RTS analysis over a period (default last 60 days): totals and breakdowns by reason, by fault, by status, plus top returned products by count and by value. Optionally filter to one brand by name.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (optional)." },
        to: { type: "string", description: "End date YYYY-MM-DD (optional)." },
        brand_name: { type: "string", description: "Brand name to filter to (optional)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_payroll_summary",
    description:
      "Recent payroll runs: period, status and total. Leadership-only — returns restricted for non-CEO/COO callers.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_pending_approvals",
    description:
      "Approval requests currently awaiting review: title, summary, action type and risk tier.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_projects",
    description:
      "The Projects Log: projects the org is working on. Defaults to active + paused (on_hold); pass status to filter. Each project has name, brand, owner, due date and status. Use this to answer 'what am I / are we working on', 'what's paused', 'what's next'.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description:
            "Optional status filter: active, planned, on_hold, completed, or archived. Omit for active + paused.",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export const ASSISTANT_TOOL_NAMES = new Set(ASSISTANT_TOOLS.map((t) => t.name));

// --- Executors -------------------------------------------------------------

async function listBrands(ctx: ToolContext): Promise<ToolResult> {
  const { data, error } = await reader(ctx)
    .from<BrandRow>("brands")
    .select("id, name, category, status, platform_focus, gmv_share")
    .order("name", { ascending: true });
  if (error) return { error: error.message };
  const brands = (data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    category: b.category,
    status: b.status,
    platform_focus: b.platform_focus ?? [],
    gmv_share: b.gmv_share,
  }));
  return { count: brands.length, brands };
}

async function listDepartments(ctx: ToolContext): Promise<ToolResult> {
  const [{ data: deptData, error }, { data: userData }] = await Promise.all([
    reader(ctx)
      .from<{ id: string; name: string; lead_user_id: string | null }>("departments")
      .select("id, name, lead_user_id")
      .order("name", { ascending: true }),
    reader(ctx)
      .from<{ id: string; full_name: string }>("users")
      .select("id, full_name"),
  ]);
  if (error) return { error: error.message };
  const nameById = new Map((userData ?? []).map((u) => [u.id, u.full_name]));
  const departments = (deptData ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    lead: d.lead_user_id ? nameById.get(d.lead_user_id) ?? null : null,
  }));
  return { count: departments.length, departments };
}

type ReturnRow = {
  brand_id: string | null;
  product_name: string | null;
  sku: string | null;
  units: number | null;
  value: number | null;
  reason: string | null;
  fault: string | null;
  status: string | null;
};

async function getReturnsAnalysis(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const { from, to } = resolveWindow(input.from, input.to, 60);
  const { brand, error: brandErr } = await resolveBrand(ctx, input.brand_name);
  if (brandErr) return { error: brandErr };

  let query = reader(ctx)
    .from<ReturnRow>("return_cases")
    .select("brand_id, product_name, sku, units, value, reason, fault, status")
    .gte("reported_date", from)
    .lte("reported_date", to);
  if (brand) query = query.eq("brand_id", brand.id);
  const { data, error } = await query;
  if (error) return { error: error.message };

  const cases = data ?? [];
  const tally = (key: keyof ReturnRow) => {
    const out: Record<string, { count: number; value: number }> = {};
    for (const c of cases) {
      const k = (c[key] as string | null) ?? "unspecified";
      const slot = out[k] ?? (out[k] = { count: 0, value: 0 });
      slot.count += 1;
      slot.value += num(c.value);
    }
    for (const k of Object.keys(out)) out[k].value = round2(out[k].value);
    return out;
  };

  // Top returned products by count and by value.
  const products = new Map<string, { count: number; value: number }>();
  for (const c of cases) {
    const key = (c.product_name ?? c.sku ?? "unspecified").trim() || "unspecified";
    const slot = products.get(key) ?? { count: 0, value: 0 };
    slot.count += 1;
    slot.value += num(c.value);
    products.set(key, slot);
  }
  const productList = Array.from(products.entries()).map(([product, v]) => ({
    product,
    count: v.count,
    value: round2(v.value),
  }));
  const topByCount = [...productList].sort((a, b) => b.count - a.count).slice(0, 5);
  const topByValue = [...productList].sort((a, b) => b.value - a.value).slice(0, 5);

  const totalValue = cases.reduce((a, c) => a + num(c.value), 0);
  const totalUnits = cases.reduce((a, c) => a + num(c.units), 0);

  return {
    period: { from, to },
    currency: "PHP",
    brand_filter: brand ? brand.name : null,
    totals: { case_count: cases.length, units: totalUnits, value: round2(totalValue) },
    by_reason: tally("reason"),
    by_fault: tally("fault"),
    by_status: tally("status"),
    top_products_by_count: topByCount,
    top_products_by_value: topByValue,
    note: cases.length === 0 ? "No return cases logged in this window." : undefined,
  };
}

type PayrollRunRow = {
  period_start: string | null;
  period_end: string | null;
  status: string | null;
  total: number | null;
};

async function getPayrollSummary(ctx: ToolContext): Promise<ToolResult> {
  // Leadership-only (salary data). RLS on payroll_runs is ceo/coo-only; the
  // explicit gate makes the restriction unambiguous to the model.
  if (!isLeadership(ctx)) {
    return {
      restricted: true,
      message: "Payroll is restricted to company leadership (CEO/COO).",
    };
  }

  const { data, error } = await reader(ctx)
    .from<PayrollRunRow>("payroll_runs")
    .select("period_start, period_end, status, total")
    .order("period_end", { ascending: false })
    .limit(12);
  if (error) return { error: error.message };

  const runs = (data ?? []).map((r) => ({
    period: `${r.period_start ?? "?"} – ${r.period_end ?? "?"}`,
    status: r.status,
    total: round2(num(r.total)),
  }));
  return {
    currency: "PHP",
    count: runs.length,
    runs,
    note: runs.length === 0 ? "No payroll runs recorded yet." : undefined,
  };
}

type ApprovalRow = {
  title: string | null;
  action_type: string | null;
  risk_tier: string | null;
  status: string | null;
  requested_by_agent: boolean | null;
  payload: { reason?: string; title?: string; tier?: string } | null;
};

async function getPendingApprovals(ctx: ToolContext): Promise<ToolResult> {
  const { data, error } = await reader(ctx)
    .from<ApprovalRow>("approval_requests")
    .select("title, action_type, risk_tier, status, requested_by_agent, payload")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) return { error: error.message };

  const approvals = (data ?? []).map((a) => ({
    title: a.title,
    action_type: a.action_type,
    risk_tier: a.risk_tier,
    // No dedicated summary column — derive a short one from the payload.
    summary:
      a.payload?.reason ??
      (a.action_type === "model_access"
        ? `Requesting ${a.payload?.tier ?? "premium"} model access`
        : a.payload?.title ?? a.action_type ?? null),
    requested_by_agent: !!a.requested_by_agent,
  }));
  return {
    count: approvals.length,
    approvals,
    note: approvals.length === 0 ? "No approvals are pending." : undefined,
  };
}

// --- Projects Log + Tony Memory --------------------------------------------
// These power both the on-demand tools below and the always-on grounding
// context injected into every assistant call (see buildGroundingContext), so
// Tony can answer "what am I working on / paused / what did we decide" without
// the model having to reach for a tool first.

type ProjectRow = {
  id: string;
  name: string;
  status: string | null;
  due_date: string | null;
  brand_id: string | null;
  owner_id: string | null;
};

type MemoryRow = {
  category: string | null;
  content: string | null;
  pinned: boolean | null;
  updated_at: string | null;
};

const PROJECT_STATUS_LABEL: Record<string, string> = {
  active: "Working On",
  planned: "Next",
  on_hold: "Paused",
  completed: "Done",
  archived: "Archived",
};

// Load Projects Log rows with brand/owner names resolved. `statuses` filters by
// project status; omit for the default active + paused set.
async function loadProjects(
  ctx: ToolContext,
  statuses: readonly string[]
): Promise<Array<{ name: string; status: string; brand: string | null; owner: string | null; due_date: string | null }>> {
  const [{ data: projData }, { data: brandData }, { data: userData }] = await Promise.all([
    reader(ctx)
      .from<ProjectRow>("projects")
      .select("id, name, status, due_date, brand_id, owner_id")
      .in("status", statuses)
      .order("due_date", { ascending: true }),
    reader(ctx).from<{ id: string; name: string }>("brands").select("id, name"),
    reader(ctx).from<{ id: string; full_name: string }>("users").select("id, full_name"),
  ]);
  const brandById = new Map((brandData ?? []).map((b) => [b.id, b.name]));
  const userById = new Map((userData ?? []).map((u) => [u.id, u.full_name]));
  return (projData ?? []).map((p) => ({
    name: p.name,
    status: p.status ?? "active",
    brand: p.brand_id ? brandById.get(p.brand_id) ?? null : null,
    owner: p.owner_id ? userById.get(p.owner_id) ?? null : null,
    due_date: p.due_date,
  }));
}

async function loadMemory(
  ctx: ToolContext,
  category: string | null,
  limit: number
): Promise<Array<{ category: string; content: string; pinned: boolean }>> {
  let q = reader(ctx)
    .from<MemoryRow>("tony_memory")
    .select("category, content, pinned, updated_at")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (category) q = q.eq("category", category.trim().toLowerCase());
  const { data } = await q;
  return (data ?? [])
    .filter((m) => m.content)
    .map((m) => ({
      category: (m.category ?? "fact").toLowerCase(),
      content: m.content as string,
      pinned: !!m.pinned,
    }));
}

async function listProjects(ctx: ToolContext, input: ToolResult): Promise<ToolResult> {
  const statusArg = typeof input.status === "string" ? input.status.trim().toLowerCase() : "";
  const statuses = statusArg ? [statusArg] : ["active", "on_hold"];
  const projects = await loadProjects(ctx, statuses);
  return {
    filter: statusArg || "active + on_hold (paused)",
    count: projects.length,
    projects: projects.map((p) => ({
      name: p.name,
      status: PROJECT_STATUS_LABEL[p.status] ?? p.status,
      brand: p.brand,
      owner: p.owner,
      due_date: p.due_date,
    })),
    note: projects.length === 0 ? "No projects match that filter." : undefined,
  };
}

// Build the always-on grounding preamble appended to the system prompt on every
// call: the org's active + paused Projects Log and its pinned + recent Tony
// Memory. Reads are RLS-scoped like every tool. Returns "" on any failure so a
// transient read error never breaks the assistant — it just answers without the
// extra context (and can still call the tools).
export async function buildGroundingContext(ctx: ToolContext): Promise<string> {
  try {
    const [projects, memory] = await Promise.all([
      loadProjects(ctx, ["active", "on_hold"]),
      loadMemory(ctx, null, 40),
    ]);

    const lines: string[] = [];

    lines.push("=== Live Projects Log (this org, current) ===");
    const working = projects.filter((p) => p.status === "active");
    const paused = projects.filter((p) => p.status === "on_hold");
    const fmt = (p: (typeof projects)[number]) => {
      const bits = [p.name];
      if (p.brand) bits.push(`(${p.brand})`);
      const meta: string[] = [];
      if (p.owner) meta.push(`owner ${p.owner}`);
      if (p.due_date) meta.push(`due ${p.due_date}`);
      return `- ${bits.join(" ")}${meta.length ? ` — ${meta.join(", ")}` : ""}`;
    };
    lines.push(`Working On (${working.length}):`);
    lines.push(working.length ? working.map(fmt).join("\n") : "- (none)");
    lines.push(`Paused (${paused.length}):`);
    lines.push(paused.length ? paused.map(fmt).join("\n") : "- (none)");

    lines.push("");
    lines.push("=== Tony Memory (durable facts — pinned first, then recent) ===");
    if (memory.length === 0) {
      lines.push("(no memories recorded yet)");
    } else {
      for (const m of memory) {
        lines.push(`- [${m.category}]${m.pinned ? " 📌" : ""} ${m.content}`);
      }
    }

    return [
      "",
      "The following is live, org-scoped context loaded for you on every message.",
      "Treat it as ground truth for questions about what the org is working on, what",
      "is paused, and what has been decided/remembered. If it is empty, say so plainly.",
      "",
      lines.join("\n"),
    ].join("\n");
  } catch {
    return "";
  }
}

// Load the caller's Personality Dial (assistant_settings) and turn it into the
// TONE MODIFIER block prepended to the system prompt. RLS scopes the read to the
// caller's own row; a missing row (new user) or any read error falls back to the
// Operator default, so the dial only ever changes phrasing and never fails the
// call. The returned modifier always carries the "delivery only" HARD RULE.
export async function loadToneModifier(ctx: ToolContext): Promise<string> {
  let tone: ToneSettings;
  try {
    const { data } = await reader(ctx)
      .from<Partial<ToneSettings>>("assistant_settings")
      .select("preset, directness, warmth, humor, brevity")
      .eq("user_id", ctx.profile.id)
      .maybeSingle();
    tone = normalizeTone(data);
  } catch {
    tone = normalizeTone(null);
  }
  return buildToneModifier(tone);
}

// --- Dispatch --------------------------------------------------------------
// Runs a single tool call. Never throws: any failure becomes { error } so the
// agentic loop can continue and the model can explain the gap.
export async function runAssistantTool(
  name: string,
  input: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as ToolResult;
  try {
    switch (name) {
      case "list_brands":
        return await listBrands(ctx);
      case "list_departments":
        return await listDepartments(ctx);
      case "get_returns_analysis":
        return await getReturnsAnalysis(ctx, args);
      case "get_payroll_summary":
        return await getPayrollSummary(ctx);
      case "get_pending_approvals":
        return await getPendingApprovals(ctx);
      case "list_projects":
        return await listProjects(ctx, args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Tool execution failed." };
  }
}
