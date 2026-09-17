// lib/metrics/signals.ts — time-based operational metrics from LIVE signals.
//
// Efficiency, Quality and Capacity are derived on the fly from the OS's own
// live rows rather than read from a hand-entered snapshot, so they reflect the
// real state of work right now:
//
//   • Efficiency   — CONFIRMED task completion. A task counts as done ONLY when
//                    it is tagged in a SUBMITTED daily report (the company-wide
//                    Daily Report is THE confirmation of task performance — see
//                    lib/daily-reports). Of the confirmed tasks that carry a due
//                    date, what share was confirmed on/before that date, lifted
//                    by throughput (tasks confirmed in the last 7 days). This
//                    REPLACES the old updated_at "done-status" proxy: there is
//                    one efficiency signal, and the daily report is its input.
//   • Quality      — data completeness (+ fulfillment quality WHEN measurable). The
//                    commerce rows come from the live tiktok_shop_performance set
//                    (via lib/metrics/gmv), which carries gmv/orders/units but no
//                    returns/fulfillment; when no return data exists, quality is
//                    scored on completeness alone rather than a fabricated perfect
//                    fulfillment (see qualityFrom).
//   • Capacity     — open/in-progress load vs headcount. Open work per active
//                    person against a target load; 100% = at target, higher =
//                    over-loaded (capped at 100 for the bar).
//
// Each value is null when the underlying signal doesn't exist yet (no confirmed
// tasks, no commerce rows, no people) — the UI then shows an explicit "no data
// yet", never a fabricated number. Pure once its inputs are fetched.

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import { todayManila } from "./windows";
import { fetchCommerceRows, type BpmRow } from "./gmv";
import { fetchConfirmedCompletions, type ConfirmationMap } from "@/lib/daily-reports/confirmations";

type Client = ReturnType<typeof createServerSupabaseClient>;

export interface SignalValue {
  value: number | null; // 0..100, or null when there's no signal
  basis: string; // short, truthful explanation of what fed it
}

export interface OrgSignals {
  efficiency: SignalValue;
  quality: SignalValue;
  capacity: SignalValue;
  computedAt: string; // ISO — when this was derived (now)
}

// Target open-tasks-per-person that reads as "fully utilized" (100%). A soft
// planning constant, documented here so the number is explainable.
const TARGET_LOAD_PER_HEAD = 5;

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

export type TaskLite = { id: string; status: string; due_date: string | null };

// Efficiency from CONFIRMED completions. `confirmed` maps a task id → the
// work_date on which a submitted daily report first confirmed it done. A task is
// "complete" here ONLY if it appears in that map — the daily report is the sole
// confirmation, replacing the old updated_at/done-status proxy. Pure: the same
// function computes the org signal and every department's signal, so there is one
// efficiency definition everywhere.
// Exported so the automated metrics_snapshots rollup writer (lib/metrics/rollup)
// derives efficiency from the SAME pure function the live dashboard uses — the
// rollup fetches its rows org-scoped (service role) and folds them through this
// exact definition, so a snapshot's efficiency can never drift from the live one.
export function efficiencyFrom(tasks: TaskLite[], confirmed: ConfirmationMap, today: string): SignalValue {
  // Confirmed completions among THIS task set, with the date they were confirmed.
  const done: { due_date: string | null; confirmedOn: string }[] = [];
  for (const t of tasks) {
    const confirmedOn = confirmed.get(t.id);
    if (confirmedOn) done.push({ due_date: t.due_date, confirmedOn });
  }

  const dueDone = done.filter((t) => t.due_date);
  if (dueDone.length === 0) {
    return { value: null, basis: "No tasks confirmed complete via a daily report yet" };
  }
  // On-time: the report that confirmed the task was filed on/before the due date.
  const onTime = dueDone.filter((t) => t.confirmedOn <= (t.due_date as string)).length;
  const onTimeRate = onTime / dueDone.length; // 0..1

  // Throughput: tasks confirmed in the trailing 7 days, saturating at 10 so a
  // steady flow reads as full marks. Lifts (or caps) the on-time rate.
  const sevenDaysAgo = shiftYmd(today, -7);
  const recentDone = done.filter((t) => t.confirmedOn >= sevenDaysAgo).length;
  const throughput = Math.min(1, recentDone / 10); // 0..1

  // 70% punctuality, 30% momentum.
  const value = clamp((onTimeRate * 0.7 + throughput * 0.3) * 100);
  return {
    value,
    basis: `${onTime}/${dueDone.length} confirmed on time · ${recentDone} confirmed in 7d`,
  };
}

// Exported for the metrics_snapshots rollup writer — same reuse rationale as
// efficiencyFrom: one quality definition, shared by the live read and the
// automated snapshot, so they always agree.
export function qualityFrom(rows: BpmRow[]): SignalValue {
  const sales = rows.filter((r) =>
    ["tiktok_shop", "shopee", "lazada", "other"].includes(r.platform)
  );
  if (sales.length === 0) {
    return { value: null, basis: "No commerce rows to score yet" };
  }
  // Completeness: share of the key commerce fields that are actually populated
  // across sales rows. The live commerce source (tiktok_shop_performance) carries
  // gmv/orders/units but NOT returns, so scoring `returns` as a "missing field"
  // would understate quality for data that is complete for what the source tracks.
  // Only fields the source can carry are counted here.
  let present = 0;
  let possible = 0;
  for (const r of sales) {
    for (const v of [r.gmv, r.orders, r.units]) {
      possible += 1;
      if (v != null) present += 1;
    }
  }
  const completeness = possible > 0 ? present / possible : 0; // 0..1

  // Fulfillment quality (low return rate + few fulfillment errors) is only
  // MEASURABLE when the source actually reports returns / fulfillment data. The
  // live TikTok commerce source does not, so when NO sales row carries either we
  // score quality on completeness ALONE rather than blending in a fabricated
  // "perfect" fulfillment (0 returns) that would inflate the number dishonestly.
  const hasFulfillmentData = sales.some(
    (r) => r.returns != null || r.return_rate != null || r.fulfillment_errors != null
  );

  if (!hasFulfillmentData) {
    return {
      value: clamp(completeness * 100),
      basis: `${Math.round(completeness * 100)}% fields complete · returns not tracked`,
    };
  }

  let orders = 0;
  let returns = 0;
  let ffErrors = 0;
  for (const r of sales) {
    orders += r.orders ?? 0;
    returns += r.returns ?? 0;
    ffErrors += r.fulfillment_errors ?? 0;
  }
  const returnRate = orders > 0 ? returns / orders : 0;
  const ffErrorRate = orders > 0 ? ffErrors / orders : 0;
  const fulfillment = Math.max(0, 1 - returnRate - ffErrorRate); // 0..1

  // Half completeness, half fulfillment cleanliness.
  const value = clamp((completeness * 0.5 + fulfillment * 0.5) * 100);
  return {
    value,
    basis:
      orders > 0
        ? `${Math.round(completeness * 100)}% fields · ${(returnRate * 100).toFixed(1)}% returns`
        : `${Math.round(completeness * 100)}% fields complete`,
  };
}

// Exported alongside efficiencyFrom / qualityFrom. The rollup does NOT currently
// write capacity (it is an honest NULL until a load-vs-headcount definition is
// ratified), but the pure function is shared so a future rollup can adopt it
// without re-deriving.
export function capacityFrom(openLoad: number, headcount: number): SignalValue {
  if (headcount === 0) {
    return { value: null, basis: "No active people on record" };
  }
  const perHead = openLoad / headcount;
  const value = clamp((perHead / TARGET_LOAD_PER_HEAD) * 100);
  return {
    value,
    basis: `${openLoad} open across ${headcount} ${headcount === 1 ? "person" : "people"}`,
  };
}

// Shift a YYYY-MM-DD by whole days (UTC math is exact for date-only strings).
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Derive the three org signals from live rows. computedAt is "now" — the values
// are recomputed on every render. Efficiency reads the confirmed daily-report
// completions (fetchConfirmedCompletions), the single source of truth.
export async function computeOrgSignals(supabase: Client): Promise<OrgSignals> {
  const today = todayManila();
  const [tasksRes, usersRes, bpmRows, confirmed] = await Promise.all([
    supabase.from("tasks").select("id, status, due_date"),
    supabase.from("users").select("id"),
    fetchCommerceRows(supabase),
    fetchConfirmedCompletions(supabase as unknown as { from: (t: string) => any }),
  ]);

  const tasks = (tasksRes.data ?? []) as unknown as TaskLite[];
  const headcount = (usersRes.data ?? []).length;
  const openLoad = tasks.filter((t) => t.status === "todo" || t.status === "in_progress" || t.status === "blocked").length;

  return {
    efficiency: efficiencyFrom(tasks, confirmed, today),
    quality: qualityFrom(bpmRows),
    capacity: capacityFrom(openLoad, headcount),
    computedAt: new Date().toISOString(),
  };
}

// Per-department Efficiency from the SAME confirmed-completion signal. Tasks
// carry no department_id, so each task is attributed to its assignee's
// department (assignee_id → users.department_id); unassigned tasks and tasks
// whose assignee has no department are left out (honest — they can't be rolled
// into any department). Returns a map department_id → SignalValue; a department
// with no confirmed-complete dated tasks yields a null value (rendered "—",
// never a fabricated 0). This is the ONE efficiency number that propagates to
// department health and the executive briefing.
export async function computeDepartmentEfficiency(
  supabase: Client
): Promise<Map<string, SignalValue>> {
  const today = todayManila();
  const [tasksRes, usersRes, confirmed] = await Promise.all([
    supabase.from("tasks").select("id, status, due_date, assignee_id"),
    supabase.from("users").select("id, department_id"),
    fetchConfirmedCompletions(supabase as unknown as { from: (t: string) => any }),
  ]);

  const deptByUser = new Map<string, string | null>();
  for (const u of (usersRes.data ?? []) as { id: string; department_id: string | null }[]) {
    deptByUser.set(u.id, u.department_id);
  }

  type TaskWithAssignee = TaskLite & { assignee_id: string | null };
  const byDept = new Map<string, TaskLite[]>();
  for (const t of (tasksRes.data ?? []) as unknown as TaskWithAssignee[]) {
    const deptId = t.assignee_id ? deptByUser.get(t.assignee_id) ?? null : null;
    if (!deptId) continue; // no department to attribute to — excluded, not zeroed
    const list = byDept.get(deptId) ?? [];
    list.push({ id: t.id, status: t.status, due_date: t.due_date });
    byDept.set(deptId, list);
  }

  const out = new Map<string, SignalValue>();
  for (const [deptId, tasks] of byDept) {
    out.set(deptId, efficiencyFrom(tasks, confirmed, today));
  }
  return out;
}

// Historical org-level snapshots (department_id IS NULL) drive the trend
// sparklines. Oldest→newest so the sparkline reads left→right in time.
export interface SnapshotPoint {
  period_end: string;
  efficiency: number;
  quality_score: number;
  capacity_utilization: number;
}

export async function getOrgSignalHistory(supabase: Client, limit = 12): Promise<SnapshotPoint[]> {
  const { data } = await supabase
    .from("metrics_snapshots")
    .select("efficiency, quality_score, capacity_utilization, period_end")
    .is("department_id", null)
    .order("period_end", { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as unknown as SnapshotPoint[];
  return rows.slice().reverse();
}
