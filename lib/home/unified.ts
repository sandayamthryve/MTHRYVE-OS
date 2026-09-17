// lib/home/unified.ts — the READ layer for the Unified Home (the role/dept
// landing at "/"). Every function here is a PURE READ that COMPOSES existing
// readers — it adds no new data layer of its own:
//
//   • assigned brands' health   → lib/quality/data (loadQualitySignals) graded by
//                                 lib/quality/signal (evaluateBrand) — the same
//                                 brand-health computation the Returns/Quality
//                                 loop routes on. The department_head home sources
//                                 its brands from department_brand_scope (the
//                                 function-derived department→brand view); the team
//                                 member home still sources from pods they lead.
//   • what needs you            → pending action_requests (head-decidable) +
//                                 task_tags (tasks tagged to the user) + the
//                                 off-target fires from the brand-health pass.
//   • Tony's brief              → lib/cognition/scope (readCompartmentScope) over
//                                 the user's department compartments.
//   • KPIs vs target            → the SAME compartment readings, presented as a
//                                 value-vs-target scoreboard (metric_targets carry
//                                 the goalposts; healthFor resolves the R/A/G dot).
//
// HONEST NULLS THROUGHOUT: a brand with no window rows reads "no recent data", a
// department with no mapped compartment reads an empty scope, and a metric with
// no entry reads "—". Nothing is fabricated, and nothing here writes.
//
// A department head's brands come from department_brand_scope (keyed by
// department_id); a team member's come from the Growth Pods they LEAD
// (pods.lead_user_id → pod_brands). Either way, no mapping → an empty, honest
// brand zone.

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadQualitySignals } from "@/lib/quality/data";
import {
  evaluateBrand,
  brandHasVolume,
  type BrandTrigger,
  type BrandQualityFacts,
} from "@/lib/quality/signal";
import { readCompartmentScope, DEFAULT_COMPARTMENT_CODES } from "@/lib/cognition/scope";
import type { CompartmentScope, MetricReading } from "@/lib/cognition/types";
import { compartmentCodesForDepartment } from "@/lib/daily-tap/metrics";
import { readTodaysTap, type TapRecord } from "@/lib/daily-tap/read";
import { buildMemberBrief, type MemberBrief } from "@/lib/home/member-brief";
import { todayManila } from "@/lib/metrics/windows";
import type { ActionRequestRow } from "@/lib/actions/types";
import type { TaskStatus, TaskPriority } from "@/types/database";

type Client = ReturnType<typeof createServerSupabaseClient>;
// The metrics / action / pod tables aren't in the generated Database types, so —
// exactly like the Cognition, Quality and Approvals modules — reads go through the
// app's read-only cast shim. Never writes.
type Shim = { from: (t: string) => any };

// A slow / missing source degrades to a neutral shape rather than throwing the
// whole home — mirrors lib/ceo/mission-control.ts and lib/home/cockpit.ts.
const safe = <T>(p: PromiseLike<T>, fallback: T): Promise<T> =>
  Promise.resolve(p).then((v) => v, () => fallback);

// ── Shared shapes ───────────────────────────────────────────────────────────────

export interface DeptRef {
  id: string;
  name: string;
}

// One brand's health verdict, from the reused quality computation.
//   • off_target — one or more quality rules fired (evaluateBrand triggers).
//   • on_track   — enough volume to judge, and nothing fired.
//   • no_data    — no rows in the trailing window, or too little volume to grade.
export type BrandVerdict = "off_target" | "on_track" | "no_data";

export interface BrandHealth {
  brandId: string;
  brandName: string | null;
  verdict: BrandVerdict;
  triggers: BrandTrigger[];
  returnRate: number | null; // fraction (0..1), null when not reported
  orders: number;
  units: number;
  gmv: number;
}

// One graded metric line for the KPI-vs-target scoreboard + Tony's read (both
// share the compartment readings, so they never disagree).
export type { MetricReading };

export interface KpiVsTarget {
  label: string; // compartment scope label
  readings: MetricReading[];
  score: number | null; // 0..100 over graded readings, null when none graded
  graded: number;
}

// One open task on the home — tagged to the user, assigned to them, or both.
export interface HomeTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  assigned: boolean;
  tagged: boolean;
}

// "What needs you" — the department head's decision queue.
export interface NeedsYou {
  approvals: ActionRequestRow[];
  taggedTasks: HomeTask[];
  brandFires: BrandHealth[]; // assigned brands whose verdict is off_target
}

// ── Small typed helpers ───────────────────────────────────────────────────────────

async function loadDeptRef(supabase: Client, departmentId: string | null): Promise<DeptRef | null> {
  if (!departmentId) return null;
  const { data } = await supabase
    .from("departments")
    .select("id, name")
    .eq("id", departmentId)
    .maybeSingle();
  return (data as DeptRef | null) ?? null;
}

// The brands in a department's scope — the function-derived department_brand_scope
// view (one row per (department, brand)), keyed by the head's users.department_id.
// This is the department_head home's brand source: in production no head LEADS a
// pod, so the pod-based linkage renders empty for every head; the DB view carries
// the real department→brand mapping. A NULL department_id — or any failed read —
// yields no brands (honest empty), never a thrown home. scope_rule is informational
// and ignored here.
async function departmentScopeBrandIds(db: Shim, departmentId: string | null): Promise<string[]> {
  if (!departmentId) return [];
  const res = await safe(
    db.from("department_brand_scope").select("brand_id").eq("department_id", departmentId),
    { data: [] as { brand_id: string }[] }
  );
  const ids = ((res.data ?? []) as { brand_id: string }[]).map((r) => r.brand_id);
  return Array.from(new Set(ids));
}

// The brands assigned to the pods a person LEADS (pods.lead_user_id) — the one
// existing person→brand linkage. Empty when they lead no pod, or their pods carry
// no brands. Best-effort: a failed read yields no assigned brands (honest empty),
// never a thrown home.
async function assignedBrandIds(db: Shim, orgId: string, userId: string): Promise<string[]> {
  const podsRes = await safe(
    db.from("pods").select("id").eq("org_id", orgId).eq("lead_user_id", userId),
    { data: [] as { id: string }[] }
  );
  const podIds = ((podsRes.data ?? []) as { id: string }[]).map((p) => p.id);
  if (podIds.length === 0) return [];
  const pbRes = await safe(db.from("pod_brands").select("brand_id").in("pod_id", podIds), {
    data: [] as { brand_id: string }[],
  });
  const ids = ((pbRes.data ?? []) as { brand_id: string }[]).map((r) => r.brand_id);
  return Array.from(new Set(ids));
}

// Grade a set of brands with the REUSED brand-health computation. A brand with no
// window rows contributes a no_data verdict (so an assigned brand never silently
// vanishes); one with rows is graded by evaluateBrand exactly as the loop grades it.
async function loadBrandHealth(
  supabase: Client,
  orgId: string,
  brandIds: string[]
): Promise<BrandHealth[]> {
  if (brandIds.length === 0) return [];
  const db = supabase as unknown as Shim;
  const wanted = new Set(brandIds);
  const [signals, brandRowsRes] = await Promise.all([
    safe(
      loadQualitySignals(db, orgId),
      null as Awaited<ReturnType<typeof loadQualitySignals>> | null
    ),
    // Names for every assigned brand — including those with no window rows, which
    // never appear in the quality signals.
    safe(db.from("brands").select("id, name").in("id", brandIds), {
      data: [] as { id: string; name: string }[],
    }),
  ]);

  const factsById = new Map<string, BrandQualityFacts>();
  for (const f of signals?.brands ?? []) {
    if (wanted.has(f.brandId)) factsById.set(f.brandId, f);
  }
  const nameById = new Map<string, string>();
  for (const b of ((brandRowsRes.data ?? []) as { id: string; name: string }[])) {
    nameById.set(b.id, b.name);
  }

  return brandIds.map((id) => {
    const facts = factsById.get(id) ?? null;
    const triggers = facts ? evaluateBrand(facts) : [];
    const verdict: BrandVerdict = !facts
      ? "no_data"
      : triggers.length > 0
        ? "off_target"
        : brandHasVolume(facts)
          ? "on_track"
          : "no_data";
    return {
      brandId: id,
      brandName: nameById.get(id) ?? facts?.brandName ?? null,
      verdict,
      triggers,
      returnRate: facts?.returnRate ?? null,
      orders: facts?.orders ?? 0,
      units: facts?.units ?? 0,
      gmv: facts?.gmv ?? 0,
    };
  });
}

// Open tasks tagged to a user (Snap-Tag) — the same two-step read the Daily Tap
// uses (tag rows, then the still-open non-archived tasks among them). Honest empty
// on any failure.
async function loadTaggedTasks(db: Shim, orgId: string, userId: string): Promise<HomeTask[]> {
  const tagRes = await safe(
    db.from("task_tags").select("task_id").eq("org_id", orgId).eq("user_id", userId),
    { data: [] as { task_id: string }[] }
  );
  const ids = ((tagRes.data ?? []) as { task_id: string }[]).map((r) => r.task_id);
  if (ids.length === 0) return [];
  const res = await safe(
    db
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .in("id", ids)
      .is("archived_at", null)
      .not("status", "in", "(done,cancelled)")
      .order("due_date", { ascending: true, nullsFirst: false }),
    { data: [] as HomeTask[] }
  );
  const rows = ((res.data ?? []) as unknown as Omit<HomeTask, "assigned" | "tagged">[]) ?? [];
  return rows.map((t) => ({ ...t, assigned: false, tagged: true }));
}

// Open tasks ASSIGNED to a user — the "today's tasks" queue (mirrors
// lib/home/cockpit.ts loadAssignedTasks).
async function loadAssignedTasks(supabase: Client, userId: string): Promise<HomeTask[]> {
  const db = supabase as unknown as Shim;
  const res = await safe(
    db
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .eq("assignee_id", userId)
      .in("status", ["todo", "in_progress", "blocked"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(30),
    { data: [] as HomeTask[] }
  );
  const rows = ((res.data ?? []) as unknown as Omit<HomeTask, "assigned" | "tagged">[]) ?? [];
  return rows.map((t) => ({ ...t, assigned: true, tagged: false }));
}

// Pending action_requests a department head can actually decide
// (required_role = 'department_head'), highest-risk first. RLS scopes to the org.
async function loadHeadApprovals(db: Shim): Promise<ActionRequestRow[]> {
  const res = await safe(
    db
      .from("action_requests")
      .select("*")
      .eq("status", "pending")
      .eq("required_role", "department_head"),
    { data: [] as ActionRequestRow[] }
  );
  const rows = ((res.data ?? []) as unknown as ActionRequestRow[]) ?? [];
  return rows.sort((a, b) => b.risk_tier - a.risk_tier || (a.created_at < b.created_at ? 1 : -1));
}

// ── Score over compartment readings ────────────────────────────────────────────────
// Operating score in [0,100] over the GRADED readings only (green=100, amber=60,
// red=0). Null when nothing is graded — honest "no score yet", never a fabricated
// 100. Mirrors lib/daily-tap/metrics.ts operatingScore, but over MetricReading[].
function scoreReadings(readings: MetricReading[]): { value: number | null; graded: number } {
  const graded = readings.filter((r) => r.dot != null);
  if (graded.length === 0) return { value: null, graded: 0 };
  const pts = graded.reduce(
    (sum, r) => sum + (r.dot === "green" ? 100 : r.dot === "amber" ? 60 : 0),
    0
  );
  return { value: Math.round(pts / graded.length), graded: graded.length };
}

// Read the department's compartment scope ONCE (falling back to the canonical
// Cognition scope — Shop Health T8 + Store Rating T9 — when the department has no
// mapped compartment), then derive both Tony's read and the KPI-vs-target grid
// from the same grounded readings so the two panels never disagree.
async function loadCompartments(
  db: Shim,
  deptName: string | null
): Promise<{ scope: CompartmentScope; kpis: KpiVsTarget }> {
  const mapped = await safe(compartmentCodesForDepartment(db, deptName), {
    codes: [] as string[],
    label: null as string | null,
  });
  const codes = mapped.codes.length ? mapped.codes : DEFAULT_COMPARTMENT_CODES;
  const scope = await safe(readCompartmentScope(db, codes), {
    codes,
    label: codes.join(", "),
    platform: null,
    readings: [] as MetricReading[],
    grounded: 0,
  });
  const { value, graded } = scoreReadings(scope.readings);
  return {
    scope,
    kpis: { label: scope.label, readings: scope.readings, score: value, graded },
  };
}

// ── Dept Head home ────────────────────────────────────────────────────────────────

export interface DeptHomeData {
  department: DeptRef | null;
  brands: BrandHealth[];
  needsYou: NeedsYou;
  tony: CompartmentScope;
  kpis: KpiVsTarget;
}

export async function loadDeptHome(
  supabase: Client,
  who: { orgId: string; userId: string; departmentId: string | null }
): Promise<DeptHomeData> {
  const db = supabase as unknown as Shim;
  const department = await loadDeptRef(supabase, who.departmentId);

  const [brandIds, approvals, taggedTasks, comp] = await Promise.all([
    departmentScopeBrandIds(db, who.departmentId),
    loadHeadApprovals(db),
    loadTaggedTasks(db, who.orgId, who.userId),
    loadCompartments(db, department?.name ?? null),
  ]);

  const brands = await loadBrandHealth(supabase, who.orgId, brandIds);
  const brandFires = brands.filter((b) => b.verdict === "off_target");

  return {
    department,
    brands,
    needsYou: { approvals, taggedTasks, brandFires },
    tony: comp.scope,
    kpis: comp.kpis,
  };
}

// ── Team member home ──────────────────────────────────────────────────────────────

export interface MemberHomeData {
  department: DeptRef | null;
  tasks: HomeTask[]; // assignee ∪ tagged, deduped
  brands: BrandHealth[]; // brands on pods they lead (usually none → honest empty)
  kpis: KpiVsTarget; // their department's KPIs vs target
  tap: TapRecord | null; // today's Daily AI Tap for this member (null → none yet)
  brief: MemberBrief; // member-scoped "root cause + top action today", grounded
}

export async function loadMemberHome(
  supabase: Client,
  who: { orgId: string; userId: string; departmentId: string | null }
): Promise<MemberHomeData> {
  const db = supabase as unknown as Shim;
  const department = await loadDeptRef(supabase, who.departmentId);
  const today = todayManila();

  const [assigned, tagged, brandIds, comp, tap] = await Promise.all([
    loadAssignedTasks(supabase, who.userId),
    loadTaggedTasks(db, who.orgId, who.userId),
    assignedBrandIds(db, who.orgId, who.userId),
    loadCompartments(db, department?.name ?? null),
    // Today's tap, read through the AUTHED client so daily_taps' self-only RLS
    // holds, and scoped to the verified user + org + Manila date. Honest null
    // when none was recorded yet.
    safe(readTodaysTap(db, who.userId, who.orgId, today), null as TapRecord | null),
  ]);

  // Union assignee ∪ tagged by task id — a task that is both keeps both flags.
  const byId = new Map<string, HomeTask>();
  for (const t of assigned) byId.set(t.id, t);
  for (const t of tagged) {
    const existing = byId.get(t.id);
    if (existing) existing.tagged = true;
    else byId.set(t.id, t);
  }
  const tasks = Array.from(byId.values()).sort((a, b) => {
    // Overdue / soonest due first; nulls (no due date) last.
    if (a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });

  const brands = await loadBrandHealth(supabase, who.orgId, brandIds);

  // The member-scoped AI Brief — distilled from THIS member's brands + their KPI
  // readings only (both already loaded above), so it can never reach past their
  // assignment. Read-only, honest-null aware, no governance data. See member-brief.
  const brief = buildMemberBrief({
    brands,
    kpis: comp.kpis,
    openTasks: tasks.length,
    today,
  });

  return { department, tasks, brands, kpis: comp.kpis, tap, brief };
}
