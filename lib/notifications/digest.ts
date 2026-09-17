// lib/notifications/digest.ts — the morning briefing engine.
//
// Once a day a scheduled job (app/api/notifications/digest) calls
// composeOrgDigests() for every org. It does two grounded things:
//
//   1. OVERDUE SWEEP — reads real overdue tasks and open cases past their due
//      date / SLA and fires the per-item producers (overdue_task, overdue_case,
//      sla_breach) to the right owner. This is where the time-based events in
//      PART B actually get produced (a trigger can't watch a clock).
//
//   2. PER-ROLE DIGEST — composes a per-user "morning briefing" notification
//      GROUNDED ONLY in the real counts it just read. CEO/COO get a 'deep'
//      digest (the whole operational picture); everyone else gets a 'standard'
//      one scoped to what they own — the mini-Tony, a department-scoped read.
//      Nothing is invented: if every signal is zero the digest says "all clear",
//      it never manufactures a number.
//
// All reads/writes run as the SYSTEM (service-role client) because the cron has
// no user session and must fan out across users; org_id is always taken from the
// org loop, never from request input. Best-effort throughout.

import { todayManila } from "@/lib/metrics/windows";
import {
  notify,
  type NotificationSeverity,
  type OrgRole,
  type Shim,
} from "@/lib/notifications/notify";
import {
  notifyOverdueTask,
  notifyOverdueCase,
  notifySlaBreach,
} from "@/lib/notifications/producers";

interface OrgUser {
  id: string;
  role: OrgRole;
  full_name: string | null;
  department_id: string | null;
}

interface OverdueTask {
  id: string;
  title: string;
  assignee_id: string | null;
  due_date: string | null;
}
interface OverdueCase {
  id: string;
  case_number: string | null;
  title: string;
  assigned_to: string | null;
  due_date: string | null;
  priority: string | null;
  status: string | null;
}

export interface OrgSignals {
  today: string;
  pendingApprovals: number;
  overdueTasks: OverdueTask[];
  overdueCases: OverdueCase[];
  slaBreaches: OverdueCase[];
  stockoutOpen: number;
  mismatchOpen: number;
}

export interface DigestResult {
  org_id: string;
  users: number;
  digestsSent: number;
  overdueTaskNotifs: number;
  overdueCaseNotifs: number;
  slaNotifs: number;
}

const OPEN_CASE_STATUSES = ["new", "assigned", "under_investigation", "awaiting_action"];

async function countPending(db: Shim, orgId: string, table: string): Promise<number> {
  try {
    const { count } = await db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending");
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function countOpenModule(db: Shim, orgId: string, sourceModule: string): Promise<number> {
  try {
    const { count } = await db
      .from("action_requests")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("source_module", sourceModule)
      .in("status", ["pending", "approved"]);
    return count ?? 0;
  } catch {
    return 0;
  }
}

// Read every real operational signal for one org. Pure reads — no writes, no
// invention. `today` is the Manila calendar date the "overdue" test uses.
export async function gatherOrgSignals(db: Shim, orgId: string): Promise<OrgSignals> {
  const today = todayManila();

  const [pendingActions, pendingLegacy, stockoutOpen, mismatchOpen] = await Promise.all([
    countPending(db, orgId, "action_requests"),
    countPending(db, orgId, "approval_requests"),
    countOpenModule(db, orgId, "warehouse"),
    countOpenModule(db, orgId, "metric_reconciliation"),
  ]);

  let overdueTasks: OverdueTask[] = [];
  try {
    const { data } = await db
      .from("tasks")
      .select("id, title, assignee_id, due_date, status")
      .eq("org_id", orgId)
      .not("due_date", "is", null)
      .lt("due_date", today)
      .neq("status", "done")
      .order("due_date", { ascending: true })
      .limit(200);
    overdueTasks = ((data as Array<OverdueTask & { status: string }> | null) ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      assignee_id: t.assignee_id,
      due_date: t.due_date,
    }));
  } catch {
    overdueTasks = [];
  }

  let overdueCases: OverdueCase[] = [];
  try {
    const { data } = await db
      .from("cases")
      .select("id, case_number, title, assigned_to, due_date, priority, status")
      .eq("org_id", orgId)
      .not("due_date", "is", null)
      .lt("due_date", today)
      .in("status", OPEN_CASE_STATUSES)
      .order("due_date", { ascending: true })
      .limit(200);
    overdueCases = (data as OverdueCase[] | null) ?? [];
  } catch {
    overdueCases = [];
  }

  // SLA breach = an overdue case at high/urgent priority (the ones with a hard
  // resolution clock). A subset of overdueCases, escalated to critical.
  const slaBreaches = overdueCases.filter((c) => c.priority === "high" || c.priority === "urgent");

  return {
    today,
    pendingApprovals: pendingActions + pendingLegacy,
    overdueTasks,
    overdueCases,
    slaBreaches,
    stockoutOpen,
    mismatchOpen,
  };
}

// Fire the per-item overdue / SLA producers from the swept lists. De-dupe in the
// producers keeps this idempotent across daily runs.
async function fireOverdueProducers(
  db: Shim,
  orgId: string,
  sig: OrgSignals
): Promise<{ tasks: number; cases: number; sla: number }> {
  let tasks = 0;
  let cases = 0;
  let sla = 0;
  const slaIds = new Set(sig.slaBreaches.map((c) => c.id));

  for (const t of sig.overdueTasks) {
    tasks += await notifyOverdueTask(
      { orgId, taskId: t.id, title: t.title, assigneeId: t.assignee_id, dueLabel: t.due_date },
      db
    );
  }
  for (const c of sig.overdueCases) {
    // A high/urgent overdue case is an SLA breach (critical); the rest are plain
    // overdue-case warnings. One notification per case, never both.
    if (slaIds.has(c.id)) {
      sla += await notifySlaBreach(
        { orgId, caseId: c.id, caseNumber: c.case_number, title: c.title, assignedTo: c.assigned_to },
        db
      );
    } else {
      cases += await notifyOverdueCase(
        {
          orgId,
          caseId: c.id,
          caseNumber: c.case_number,
          title: c.title,
          assignedTo: c.assigned_to,
          dueLabel: c.due_date,
        },
        db
      );
    }
  }
  return { tasks, cases, sla };
}

// Compose the grounded digest body for one user, given the real signals and the
// user's own overdue counts. Deep = full picture (leadership); standard = scoped.
function digestFor(
  user: OrgUser,
  sig: OrgSignals,
  mine: { tasks: number; cases: number }
): { title: string; body: string; severity: NotificationSeverity } {
  const deep = user.role === "ceo" || user.role === "coo";
  const first = (user.full_name ?? "").split(/\s+/)[0] || "there";
  const lines: string[] = [];

  if (deep) {
    // The whole operational read, every figure real.
    if (sig.pendingApprovals > 0) lines.push(`${sig.pendingApprovals} approval${sig.pendingApprovals === 1 ? "" : "s"} awaiting a decision`);
    if (sig.slaBreaches.length > 0) lines.push(`${sig.slaBreaches.length} SLA breach${sig.slaBreaches.length === 1 ? "" : "es"} (high/urgent cases overdue)`);
    if (sig.overdueCases.length > 0) lines.push(`${sig.overdueCases.length} case${sig.overdueCases.length === 1 ? "" : "s"} overdue`);
    if (sig.overdueTasks.length > 0) lines.push(`${sig.overdueTasks.length} task${sig.overdueTasks.length === 1 ? "" : "s"} overdue`);
    if (sig.stockoutOpen > 0) lines.push(`${sig.stockoutOpen} stockout risk${sig.stockoutOpen === 1 ? "" : "s"} in the queue`);
    if (sig.mismatchOpen > 0) lines.push(`${sig.mismatchOpen} metric mismatch${sig.mismatchOpen === 1 ? "" : "es"} to reconcile`);
  } else {
    // Mini-Tony: scoped to what this person owns. Approvals a head can decide,
    // plus their own overdue work.
    if (user.role === "department_head" && sig.pendingApprovals > 0) {
      lines.push(`${sig.pendingApprovals} approval${sig.pendingApprovals === 1 ? "" : "s"} in the queue`);
    }
    if (mine.cases > 0) lines.push(`${mine.cases} case${mine.cases === 1 ? "" : "s"} assigned to you are overdue`);
    if (mine.tasks > 0) lines.push(`${mine.tasks} of your task${mine.tasks === 1 ? "" : "s"} ${mine.tasks === 1 ? "is" : "are"} overdue`);
  }

  const severity: NotificationSeverity =
    (deep && sig.slaBreaches.length > 0) || mine.cases > 0
      ? "warning"
      : "info";

  const body =
    lines.length > 0
      ? `Good morning ${first}. Here's your grounded read for today:\n• ${lines.join("\n• ")}`
      : `Good morning ${first}. All clear — nothing overdue, no approvals waiting, no open risks. Grounded in real data as of ${sig.today}.`;

  return {
    title: lines.length > 0 ? `Morning briefing · ${lines.length} thing${lines.length === 1 ? "" : "s"} to know` : "Morning briefing · all clear",
    body,
    severity,
  };
}

// One org: sweep overdue producers, then send each user a grounded morning
// digest. Returns a small summary for the cron response.
export async function composeOrgDigests(db: Shim, orgId: string): Promise<DigestResult> {
  const sig = await gatherOrgSignals(db, orgId);
  const swept = await fireOverdueProducers(db, orgId, sig);

  // Every member of the org gets a per-role digest.
  let users: OrgUser[] = [];
  try {
    const { data } = await db
      .from("users")
      .select("id, role, full_name, department_id")
      .eq("org_id", orgId);
    users = (data as OrgUser[] | null) ?? [];
  } catch {
    users = [];
  }

  // Pre-index each user's own overdue counts (personal scope for the mini-Tony).
  const myTasks = new Map<string, number>();
  for (const t of sig.overdueTasks) {
    if (t.assignee_id) myTasks.set(t.assignee_id, (myTasks.get(t.assignee_id) ?? 0) + 1);
  }
  const myCases = new Map<string, number>();
  for (const c of sig.overdueCases) {
    if (c.assigned_to) myCases.set(c.assigned_to, (myCases.get(c.assigned_to) ?? 0) + 1);
  }

  let digestsSent = 0;
  for (const u of users) {
    const d = digestFor(u, sig, {
      tasks: myTasks.get(u.id) ?? 0,
      cases: myCases.get(u.id) ?? 0,
    });
    digestsSent += await notify(
      {
        orgId,
        type: "morning_digest",
        severity: d.severity,
        title: d.title,
        body: d.body,
        entityType: "digest",
        entityId: `${sig.today}:${u.id}`, // one digest per user per day
        userIds: [u.id],
        dedupeWithinHours: 20,
      },
      db
    );
  }

  return {
    org_id: orgId,
    users: users.length,
    digestsSent,
    overdueTaskNotifs: swept.tasks,
    overdueCaseNotifs: swept.cases,
    slaNotifs: swept.sla,
  };
}
