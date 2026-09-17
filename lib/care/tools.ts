// lib/care/tools.ts — Care agent tools (READ + direct + approval).
// All reads run on the caller's RLS-scoped @supabase/ssr client so org scoping
// and per-role visibility are automatic. Tools degrade to honest empties.

import type { SessionProfile } from "@/lib/auth/session";
import { searchKnowledge } from "@/lib/knowledge/search";
import { isProbationary, probationDaysLeft } from "@/lib/auth/session";
import { canManageProbation, PROBATION_REVIEW_WINDOW_DAYS } from "@/lib/people/probation";
import { writeActionAudit } from "@/lib/actions/audit";

type Shim = { from: (t: string) => any };
export type CareToolContext = { supabase: unknown; profile: SessionProfile };
function db(ctx: CareToolContext): Shim { return ctx.supabase as Shim; }
export type ToolResult = Record<string, unknown>;

function num(v: unknown): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }

// ── get_my_care_summary: self-only wellbeing snapshot ────────────────────────
async function getMyCareSummary(ctx: CareToolContext): Promise<ToolResult> {
  const me = ctx.profile.id;
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const [{ data: userData }, { data: attData }, { data: pulseData }] = await Promise.all([
      db(ctx).from("users").select("full_name, employment_status, probation_end, department_id").eq("id", me).maybeSingle(),
      db(ctx).from("attendance").select("status, late_minutes, total_hours, work_date").eq("user_id", me).gte("work_date", since).order("work_date", { ascending: false }).limit(14) as any,
      db(ctx).from("wellbeing_pulses").select("mood, pulse_date, note").eq("user_id", me).order("pulse_date", { ascending: false }).limit(7) as any,
    ]);
    const u = userData as any;
    const probation = u ? { employment_status: u.employment_status, probation_end: u.probation_end, probation_days_left: probationDaysLeft(u as any), is_probationary: isProbationary(u.employment_status) } : null;
    const attendance = (attData ?? []) as any[];
    const pulses = (pulseData ?? []) as any[];
    const avgMood = pulses.length ? pulses.reduce((a: number, r: any) => a + num(r.mood), 0) / pulses.length : null;
    return {
      for_user: ctx.profile.full_name,
      probation,
      attendance_14d: { count: attendance.length, items: attendance.slice(0, 7) },
      wellbeing_recent: { count: pulses.length, avg_mood: avgMood != null ? Math.round(avgMood * 10) / 10 : null, items: pulses },
      note: pulses.length === 0 ? "No wellbeing pulses yet — you can log one with mood 1-5." : undefined,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not load your care summary." };
  }
}

// ── get_team_care_pulse: HR/leadership aggregates (anonymized mood) ───────
async function getTeamCarePulse(ctx: CareToolContext): Promise<ToolResult> {
  // Gate: HR head + leadership only — mirrors canManageProbation / ceo/coo.
  const role = ctx.profile.role;
  const isLeadership = role === "ceo" || role === "coo";
  let isHrHead = false;
  try { isHrHead = await canManageProbation(db(ctx), ctx.profile as any); } catch {}
  if (!isLeadership && !isHrHead) {
    return { restricted: true, message: "Team pulse is HR/leadership only — aggregates are anonymized for others." };
  }
  try {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [{ data: pulseData }, { data: userData }, { data: attData }] = await Promise.all([
      db(ctx).from("wellbeing_pulses").select("mood, pulse_date").gte("pulse_date", since).limit(200) as any,
      db(ctx).from("users").select("id, employment_status, probation_end").eq("org_id", ctx.profile.org_id) as any,
      db(ctx).from("attendance").select("user_id, status, work_date").gte("work_date", since) as any,
    ]);
    const pulses = (pulseData ?? []) as any[];
    const users = (userData ?? []) as any[];
    const att = (attData ?? []) as any[];
    const moods = pulses.map((r: any) => num(r.mood)).filter((n: number) => n >= 1 && n <= 5);
    const avgMood = moods.length ? moods.reduce((a: number, b: number) => a + b, 0) / moods.length : null;
    const probationQueue = users.filter((u: any) => isProbationary(u.employment_status) && u.probation_end).length;
    const reviewDue = users.filter((u: any) => {
      const left = probationDaysLeft(u, new Date());
      return left !== null && left <= PROBATION_REVIEW_WINDOW_DAYS;
    }).length;
    const lateCount = att.filter((a: any) => a.status === "late").length;
    return {
      window: { since, today: new Date().toISOString().slice(0, 10) },
      anonymized: true,
      pulse_14d: { count: pulses.length, avg_mood: avgMood != null ? Math.round(avgMood * 10) / 10 : null },
      probation: { queued: probationQueue, review_due: reviewDue, window_days: PROBATION_REVIEW_WINDOW_DAYS },
      attendance_14d: { records: att.length, late: lateCount },
      note: pulses.length === 0 ? "No pulses in 14d — invite the team to share anonymously." : undefined,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not load team pulse." };
  }
}

// ── get_probation_care_context: one hire with care context ──────────────────
async function getProbationCareContext(ctx: CareToolContext, input: ToolResult): Promise<ToolResult> {
  const q = typeof input.person === "string" ? input.person.trim().toLowerCase() : "";
  if (!q) return { error: "Who? Give me the person's name (probationary hire)." };
  // Gate: care context is HR/leadership only for another person's data.
  let canSee = ctx.profile.role === "ceo" || ctx.profile.role === "coo";
  if (!canSee) try { canSee = await canManageProbation(db(ctx), ctx.profile as any); } catch {}
  if (!canSee) return { restricted: true, message: "Probation care context is HR/leadership only." };
  try {
    const { data: users } = await db(ctx).from("users").select("id, full_name, email, employment_status, probation_end, department_id").eq("org_id", ctx.profile.org_id).ilike("full_name", `%${q}%`) as any;
    const rows = (users ?? []) as any[];
    let hit = rows.find((r: any) => (r.full_name ?? "").toLowerCase() === q) ?? rows[0];
    if (!hit) return { error: `No person matching "${input.person}".` };
    if (!isProbationary(hit.employment_status)) return { person: hit.full_name, employment_status: hit.employment_status, note: "Not probationary — no probation care window." };
    const daysLeft = probationDaysLeft(hit, new Date());
    const reviewDue = daysLeft !== null && daysLeft <= PROBATION_REVIEW_WINDOW_DAYS;
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data: att } = await db(ctx).from("attendance").select("status, work_date, late_minutes").eq("user_id", hit.id).gte("work_date", since).order("work_date", { ascending: false }).limit(14) as any;
    const attRows = (att ?? []) as any[];
    return {
      person: { id: hit.id, full_name: hit.full_name, email: hit.email, employment_status: hit.employment_status, probation_end: hit.probation_end, days_left: daysLeft, review_due: reviewDue },
      attendance_14d: { count: attRows.length, late: attRows.filter((a: any) => a.status === "late").length, items: attRows.slice(0, 5) },
      suggested: reviewDue ? "Review due — schedule a care check-in and decide: regularize / extend / release." : "Monitoring — keep weekly check-ins until review window.",
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not load probation context." };
  }
}

// ── search_hr_knowledge: RAG over HR docs ───────────────────────────────────
async function searchHrKnowledge(input: ToolResult): Promise<ToolResult> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { error: "What should I look up in HR knowledge?" };
  try {
    const chunks = await searchKnowledge(query, 6).catch(() => null);
    if (!chunks) return { count: 0, chunks: [], note: "HR knowledge search unavailable right now." };
    if (chunks.length === 0) return { count: 0, chunks: [], note: "No HR docs matched." };
    return { count: chunks.length, chunks: chunks.map((c: any) => ({ source_title: c.title, source_type: c.source_type, excerpt: c.content })), note: "Cite source_title when you use these." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "HR knowledge search failed." };
  }
}

// ── log_wellbeing_pulse: direct self-write ──────────────────────────────────
async function logWellbeingPulse(ctx: CareToolContext, input: ToolResult): Promise<ToolResult> {
  const mood = Number(input.mood);
  if (!Number.isInteger(mood) || mood < 1 || mood > 5) return { error: "Mood must be an integer 1-5 (1 low, 5 great)." };
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await (db(ctx).from("wellbeing_pulses") as any).upsert(
      { org_id: ctx.profile.org_id, user_id: ctx.profile.id, mood, note, pulse_date: today },
      { onConflict: "org_id,user_id,pulse_date" }
    ).select("id, pulse_date").single();
    if (error) return { error: error.message };
    return { ok: true, tier: "direct", pulse: { id: (data as any).id, pulse_date: (data as any).pulse_date, mood, note }, message: mood <= 2 ? "Logged — thank you for sharing. If you need support, reach out to HR; I'm here to listen." : "Logged — thank you for sharing." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not log pulse." };
  }
}

// ── propose_check_in: approval-gated internal check-in ─────────────────────
async function proposeCheckIn(ctx: CareToolContext, input: ToolResult): Promise<ToolResult> {
  const person = typeof input.person === "string" ? input.person.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!person) return { error: "Who is the check-in for? Give me the person's name." };
  if (!reason) return { error: "Why? Give a short reason for the check-in (1 line)." };
  const capCanPropose = ctx.profile.role === "ceo" || ctx.profile.role === "coo" || ctx.profile.role === "department_head";
  if (!capCanPropose) return { routed: true, message: "You can't file check-ins at your level — I'll flag it for your HR head / leadership." };
  try {
    // Resolve person by name (org-scoped)
    const { data: users } = await db(ctx).from("users").select("id, full_name").eq("org_id", ctx.profile.org_id).ilike("full_name", `%${person}%`) as any;
    const rows = (users ?? []) as any[];
    const hit = rows.find((r: any) => (r.full_name ?? "").toLowerCase() === person.toLowerCase()) ?? rows[0];
    if (!hit) return { error: `No person matching "${person}".` };
    const title = `Care check-in · ${hit.full_name} — ${reason.slice(0, 80)}`;
    const draft: Record<string, unknown> = {
      source_module: "care",
      source_ref: { user_id: hit.id, by: ctx.profile.id },
      title,
      problem: reason,
      recommendation: `HR to check in on ${hit.full_name}: ${reason}`,
      confidence: 0.6,
      risk_tier: 1,
      required_role: "department_head",
      proposed_action: { type: "care_check_in", payload: { user_id: hit.id, reason } },
      status: "pending",
    };
    const { data, error } = await (db(ctx).from("action_requests") as any).insert({ org_id: ctx.profile.org_id, created_by: ctx.profile.id, status: "pending", ...draft }).select("id, title, required_role").single();
    if (error) return { routed: true, message: "You don't have permission to file a check-in — I'll flag it for HR.", detail: error.message };
    const row = data as any;
    await writeActionAudit(db(ctx) as any, { org_id: ctx.profile.org_id, action_request_id: row.id, event: "created", actor_id: ctx.profile.id, actor_role: ctx.profile.role, detail: { source: "care_act", kind: "care_check_in", user_id: hit.id } });
    // Mirror into care_check_ins ledger (best-effort, never fails the proposal)
    try {
      await (db(ctx).from("care_check_ins") as any).insert({ org_id: ctx.profile.org_id, user_id: hit.id, action_request_id: row.id, reason, created_by: ctx.profile.id, status: "proposed" });
    } catch {}
    return { ok: true, tier: "proposed", proposed: { id: row.id, title: row.title, status: "pending" }, message: `Filed Care check-in for ${hit.full_name} into Approval Queue as pending — HR approves before anyone is contacted.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not file check-in." };
  }
}

// ── Tool schemas (Anthropic) ────────────────────────────────────────────────
export const GET_MY_CARE_SUMMARY_TOOL = {
  name: "get_my_care_summary",
  description: "YOUR own care snapshot: probation status, 14d attendance, and your recent wellbeing pulses. Self-scoped — use for 'how am I doing', 'my probation', 'my wellbeing'.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
} as const;
export const GET_TEAM_CARE_PULSE_TOOL = {
  name: "get_team_care_pulse",
  description: "Team care pulse (HR/leadership only): anonymized 14d mood avg + count, probation queue depth, review-due, and attendance late. Use for 'how is the team', 'wellbeing pulse'. Aggregates only — no raw individual mood.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
} as const;
export const GET_PROBATION_CARE_CONTEXT_TOOL = {
  name: "get_probation_care_context",
  description: "One probationary hire with care context: probation_end, days left, review-due flag, and 14d attendance. HR/leadership only. Use for 'check on <name> probation care'.",
  input_schema: { type: "object", properties: { person: { type: "string", description: "Full name of the probationary hire" } }, required: ["person"], additionalProperties: false },
} as const;
export const SEARCH_HR_KNOWLEDGE_TOOL = {
  name: "search_hr_knowledge",
  description: "Search HR SOPs/policies in Knowledge Base and get citable excerpts with source title. Use for 'HR policy on leave', 'probation SOP'. Cite source_title.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
} as const;
export const LOG_WELLBEING_PULSE_TOOL = {
  name: "log_wellbeing_pulse",
  description: "Log YOUR wellbeing pulse mood 1-5 (1 low — 5 great) with optional short note. Self-only, upserts today. Use when user says 'I feel X' or wants to log mood.",
  input_schema: { type: "object", properties: { mood: { type: "integer", minimum: 1, maximum: 5 }, note: { type: "string" } }, required: ["mood"], additionalProperties: false },
} as const;
export const PROPOSE_CHECK_IN_TOOL = {
  name: "propose_check_in",
  description: "Propose a Care check-in for someone (HR approves before anyone is contacted). Use for 'check in on <name> because ...'. Files pending, never auto-contacts.",
  input_schema: { type: "object", properties: { person: { type: "string" }, reason: { type: "string" } }, required: ["person", "reason"], additionalProperties: false },
} as const;

export function buildCareTools(role: string) {
  // All roles get READ + self pulse log; propose is approval-gated via tool-tiers but still listed.
  return [
    GET_MY_CARE_SUMMARY_TOOL,
    GET_TEAM_CARE_PULSE_TOOL,
    GET_PROBATION_CARE_CONTEXT_TOOL,
    SEARCH_HR_KNOWLEDGE_TOOL,
    LOG_WELLBEING_PULSE_TOOL,
    PROPOSE_CHECK_IN_TOOL,
  ];
}
export const CARE_TOOL_NAMES = new Set([GET_MY_CARE_SUMMARY_TOOL.name, GET_TEAM_CARE_PULSE_TOOL.name, GET_PROBATION_CARE_CONTEXT_TOOL.name, SEARCH_HR_KNOWLEDGE_TOOL.name, LOG_WELLBEING_PULSE_TOOL.name, PROPOSE_CHECK_IN_TOOL.name]);

export async function runCareTool(name: string, input: unknown, ctx: CareToolContext): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as ToolResult;
  try {
    switch (name) {
      case "get_my_care_summary": return await getMyCareSummary(ctx);
      case "get_team_care_pulse": return await getTeamCarePulse(ctx);
      case "get_probation_care_context": return await getProbationCareContext(ctx, args);
      case "search_hr_knowledge": return await searchHrKnowledge(args);
      case "log_wellbeing_pulse": return await logWellbeingPulse(ctx, args);
      case "propose_check_in": return await proposeCheckIn(ctx, args);
      default: return { error: `Unknown Care tool: ${name}` };
    }
  } catch (e) { return { error: e instanceof Error ? e.message : "Care tool failed." }; }
}
