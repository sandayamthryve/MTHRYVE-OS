// lib/home/cockpit.ts — shared, read-only data loaders for the per-role Role
// Homes (My Day · Dept Cockpit · Operations) and the Leadership View-As surface.
//
// Every function here is a PURE READ. It never writes. The live role-home pages
// compose these reads with their own write controls (Quick Entry, Submit Daily
// Report, Approve/Reject); the View-As page composes the SAME reads with NO write
// controls, so a leader viewing someone else's home sees exactly their data and
// can change nothing. Because the reads run through the caller's own Supabase
// session, RLS remains the real gate — leadership can read org-wide, a member
// only their own rows. The loaders take an explicit `userId` / `departmentId` so
// View-As can scope a read to the target person (org + that user_id) without ever
// impersonating them at the auth layer.

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { TaskStatus, TaskPriority } from "@/types/database";
import { manilaToday } from "@/lib/hr/time";
import {
  rollupByCategory,
  type LiveBottleneck,
  type CategoryRollup,
} from "@/lib/live-ops/bottlenecks";
import type { ActionRequestRow, ActionAuditRow } from "@/lib/actions/types";
import {
  DEPARTMENTS,
  metricsDepartmentForName,
  type Department,
} from "@/lib/metrics/types";

// Re-exported from the metrics types (single source of truth) so existing
// importers keep working. The org department name → metrics-floor Department
// bridge now lives with the Department taxonomy it maps onto.
export { metricsDepartmentForName };

type Client = ReturnType<typeof createServerSupabaseClient>;
// The audit / live / action tables aren't in the generated Database types yet, so
// — exactly like the Live, Contracts and Approvals modules — we read/write them
// through the app's cast shim.
type Shim = { from: (t: string) => any };

export function isDepartmentKey(v: string): v is Department {
  return (DEPARTMENTS as readonly string[]).includes(v);
}

// ── Shared shapes ──────────────────────────────────────────────────────────────
export interface DeptRef {
  id: string;
  name: string;
}

export interface DeptMetrics {
  efficiency: number | null;
  quality_score: number | null;
  capacity_utilization: number | null;
  period_end: string | null;
}

export interface CockpitTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
}

export interface DailyReportStatus {
  filedToday: boolean;
  workDate: string;
  deliverables: string | null;
  summary: string | null;
}

// One teammate's daily-report standing for today (Dept Cockpit "who filed" panel).
export interface MemberReportStanding {
  id: string;
  full_name: string;
  filed: boolean;
}

// ── Small typed helpers (avoid the @supabase/ssr select-inference `never` quirk) ─
async function loadDeptRef(supabase: Client, departmentId: string | null): Promise<DeptRef | null> {
  if (!departmentId) return null;
  const { data } = await supabase
    .from("departments")
    .select("id, name")
    .eq("id", departmentId)
    .maybeSingle();
  return (data as DeptRef | null) ?? null;
}

async function loadDeptMetrics(
  supabase: Client,
  departmentId: string | null
): Promise<DeptMetrics | null> {
  if (!departmentId) return null;
  const { data } = await supabase
    .from("metrics_snapshots")
    .select("efficiency, quality_score, capacity_utilization, period_end")
    .eq("department_id", departmentId)
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as DeptMetrics | null) ?? null;
}

// Open tasks assigned to a person — the "today's tasks" queue. Excludes done /
// cancelled; overdue and due-today float up because we order by due date.
async function loadAssignedTasks(supabase: Client, userId: string): Promise<CockpitTask[]> {
  const { data } = await supabase
    .from("tasks")
    .select("id, title, status, priority, due_date")
    .eq("assignee_id", userId)
    .in("status", ["todo", "in_progress", "blocked"])
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(20);
  return ((data ?? []) as unknown as CockpitTask[]) ?? [];
}

// Whether a person has filed today's Daily Report, and — if so — what it said.
// Reads attendance (report_submitted flag for today) then the linked report.
async function loadDailyReport(
  supabase: Client,
  userId: string
): Promise<DailyReportStatus> {
  const workDate = manilaToday();
  const db = supabase as unknown as Shim;
  let filed = false;
  try {
    const { data } = await db
      .from("attendance")
      .select("report_submitted")
      .eq("user_id", userId)
      .eq("work_date", workDate)
      .maybeSingle();
    filed = Boolean((data as { report_submitted?: boolean } | null)?.report_submitted);
  } catch {
    filed = false;
  }

  let deliverables: string | null = null;
  let summary: string | null = null;
  if (filed) {
    const { data: rep } = await supabase
      .from("reports")
      .select("content")
      .eq("generated_by", userId)
      .eq("period_end", workDate)
      .eq("type", "daily")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const content = (rep as { content?: Record<string, unknown> } | null)?.content ?? null;
    if (content) {
      const d = content["deliverables"];
      const s = content["summary"];
      deliverables = typeof d === "string" ? d : null;
      summary = typeof s === "string" ? s : null;
    }
  }
  return { filedToday: filed, workDate, deliverables, summary };
}

// ── My Day (team_member) ────────────────────────────────────────────────────────
export interface MyDayData {
  department: DeptRef | null;
  metricsDepartment: Department | null;
  metrics: DeptMetrics | null;
  tasks: CockpitTask[];
  report: DailyReportStatus;
}

export async function loadMyDay(
  supabase: Client,
  who: { userId: string; departmentId: string | null }
): Promise<MyDayData> {
  const [department, metrics, tasks, report] = await Promise.all([
    loadDeptRef(supabase, who.departmentId),
    loadDeptMetrics(supabase, who.departmentId),
    loadAssignedTasks(supabase, who.userId),
    loadDailyReport(supabase, who.userId),
  ]);
  return {
    department,
    metricsDepartment: metricsDepartmentForName(department?.name),
    metrics,
    tasks,
    report,
  };
}

// ── Dept Cockpit (department_head) ────────────────────────────────────────────────
export interface DeptCockpitData {
  department: DeptRef | null;
  metrics: DeptMetrics | null;
  metricsDepartment: Department | null;
  approvals: ActionRequestRow[];
  approvalsAudit: ActionAuditRow[];
  userNames: Map<string, string>;
  standings: MemberReportStanding[];
  filedCount: number;
  memberCount: number;
}

export async function loadDeptCockpit(
  supabase: Client,
  who: { orgId: string; departmentId: string | null }
): Promise<DeptCockpitData> {
  const db = supabase as unknown as Shim;

  const [department, metrics, membersRes, approvalsRes, auditRes] = await Promise.all([
    loadDeptRef(supabase, who.departmentId),
    loadDeptMetrics(supabase, who.departmentId),
    who.departmentId
      ? supabase
          .from("users")
          .select("id, full_name")
          .eq("department_id", who.departmentId)
          .order("full_name")
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    // Pending action_requests the department needs a decision on. RLS scopes to
    // the caller's org; we surface only pending here.
    safe(db.from("action_requests").select("*"), { data: [] as ActionRequestRow[] }),
    safe(
      db
        .from("action_audit")
        .select("id, org_id, action_request_id, event, actor_id, actor_role, detail, created_at")
        .order("created_at", { ascending: true }),
      { data: [] as ActionAuditRow[] }
    ),
  ]);

  const members = ((membersRes.data ?? []) as unknown as { id: string; full_name: string }[]) ?? [];
  const userNames = new Map(members.map((m) => [m.id, m.full_name]));

  // Who filed today's Daily Report vs. not — one attendance read for the team.
  const workDate = manilaToday();
  const memberIds = members.map((m) => m.id);
  let filedSet = new Set<string>();
  if (memberIds.length > 0) {
    try {
      const { data } = await db
        .from("attendance")
        .select("user_id, report_submitted")
        .eq("work_date", workDate)
        .in("user_id", memberIds);
      const rows = (data ?? []) as { user_id: string; report_submitted: boolean | null }[];
      filedSet = new Set(rows.filter((r) => r.report_submitted).map((r) => r.user_id));
    } catch {
      filedSet = new Set();
    }
  }
  const standings: MemberReportStanding[] = members.map((m) => ({
    id: m.id,
    full_name: m.full_name,
    filed: filedSet.has(m.id),
  }));

  const allApprovals = ((approvalsRes.data ?? []) as unknown as ActionRequestRow[]) ?? [];
  const approvals = allApprovals
    .filter((a) => a.status === "pending")
    .sort((a, b) => b.risk_tier - a.risk_tier || (a.created_at < b.created_at ? 1 : -1));

  return {
    department,
    metrics,
    metricsDepartment: metricsDepartmentForName(department?.name),
    approvals,
    approvalsAudit: ((auditRes.data ?? []) as unknown as ActionAuditRow[]) ?? [],
    userNames,
    standings,
    filedCount: filedSet.size,
    memberCount: members.length,
  };
}

// ── Operations (coo) ──────────────────────────────────────────────────────────────
export interface OperationsData {
  approvals: ActionRequestRow[];
  approvalsAudit: ActionAuditRow[];
  userNames: Map<string, string>;
  bottlenecks: CategoryRollup[];
  openBottleneckCount: number;
}

export async function loadOperations(
  supabase: Client,
  who: { orgId: string }
): Promise<OperationsData> {
  const db = supabase as unknown as Shim;
  const [approvalsRes, auditRes, usersRes, bottleneckRes] = await Promise.all([
    safe(db.from("action_requests").select("*"), { data: [] as ActionRequestRow[] }),
    safe(
      db
        .from("action_audit")
        .select("id, org_id, action_request_id, event, actor_id, actor_role, detail, created_at")
        .order("created_at", { ascending: true }),
      { data: [] as ActionAuditRow[] }
    ),
    safe(db.from("users").select("id, full_name"), {
      data: [] as { id: string; full_name: string }[],
    }),
    safe(db.from("live_bottlenecks").select("*"), { data: [] as LiveBottleneck[] }),
  ]);

  const users = ((usersRes.data ?? []) as unknown as { id: string; full_name: string }[]) ?? [];
  const userNames = new Map(users.map((u) => [u.id, u.full_name]));

  const allApprovals = ((approvalsRes.data ?? []) as unknown as ActionRequestRow[]) ?? [];
  const approvals = allApprovals
    .filter((a) => a.status === "pending")
    .sort((a, b) => b.risk_tier - a.risk_tier || (a.created_at < b.created_at ? 1 : -1));

  const rawBottlenecks = ((bottleneckRes.data ?? []) as unknown as LiveBottleneck[]) ?? [];
  const openBottlenecks = rawBottlenecks.filter(
    (b) => b.status === "open" || b.status === "assigned" || b.status === "in_progress"
  );

  return {
    approvals,
    approvalsAudit: ((auditRes.data ?? []) as unknown as ActionAuditRow[]) ?? [],
    userNames,
    bottlenecks: rollupByCategory(rawBottlenecks),
    openBottleneckCount: openBottlenecks.length,
  };
}

// A slow / missing source degrades to a neutral shape rather than throwing the
// whole cockpit — mirrors lib/ceo/mission-control.ts.
function safe<T>(p: PromiseLike<T>, fallback: T): Promise<T> {
  return Promise.resolve(p).then((v) => v, () => fallback);
}
