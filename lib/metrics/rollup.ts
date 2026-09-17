// lib/metrics/rollup.ts — the automated DEPARTMENT-HEALTH rollup writer.
//
// Folds the OS's own live rows into ONE metrics_snapshots row per
// (org_id, department_id, period), plus one org-level roll-up row per org
// (department_id NULL). This is the metrics analogue of the TikTok daily sync:
// same shape, same idempotent-upsert discipline, same source/synced_at stamping,
// same Manila "period ending yesterday" window — so every health surface in the
// OS (mission-control, home cockpit, OS snapshot, signals sparkline, review) reads
// a fresh snapshot instead of a hand-entered one that goes stale the day it lands.
//
// WHAT EACH COLUMN COMES FROM (CEO decision, PR 5):
//   • gmv_impact           — REAL revenue from public.tiktok_shop_performance, the
//                            ONE GMV source of truth (PR 1 / PR 3), read through the
//                            SAME range-aware helper every commerce surface uses
//                            (lib/metrics/tiktok-live: getLiveDaysByBrand +
//                            sumOrgGmvWindow). NEVER metric_entries — that is a
//                            manual-entry ledger, not a revenue source, and sourcing
//                            GMV from it was the exact non-reconciling second-source
//                            defect PR 3 removed. Commerce GMV belongs to the
//                            department that owns commerce (E-Commerce Ops); the
//                            org-level row rolls from the SAME figure, so department
//                            health reconciles with the Command Center by
//                            construction. Departments with no revenue attribution
//                            stay 0.
//   • efficiency           — reuses efficiencyFrom() from lib/metrics/signals.ts,
//                            the SAME confirmed-daily-report signal the live
//                            dashboard uses, computed per department (a task is
//                            attributed to its assignee's department).
//   • quality_score        — reuses qualityFrom() from lib/metrics/signals.ts. The
//                            commerce-quality signal is scored on the live TikTok
//                            Shop data, which belongs to E-Commerce, so it lands on
//                            the E-Commerce department row and the org-level row;
//                            departments with no commerce signal get an honest NULL.
//   • capacity_utilization — HONEST NULL. No load-vs-headcount definition is
//                            ratified, so it is written NULL (renders "—"), never a
//                            fabricated 0 or 100.
//
// SCOPING: unlike the live signals.ts helpers (which lean on RLS to scope to one
// org), this writer runs under the service role and can span every org on a
// machine trigger, so it fetches each org's rows with an explicit org_id filter
// and folds them through the SAME pure derivations. Mirrors lib/tiktok/reconcile
// and lib/tiktok/metric-entries.
//
// IDEMPOTENT: every row upserts on the natural key
// (org_id, department_id, period_start, period_end) — the
// metrics_snapshots_org_dept_period_uniq index (NULLS NOT DISTINCT). Re-running a
// window updates the same rows in place; it never inserts a duplicate.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { efficiencyFrom, qualityFrom, type SignalValue, type TaskLite } from "./signals";
import { brandDayToRow, type BpmRow } from "./gmv";
import { getLiveDaysByBrand, sumOrgGmvWindow } from "./tiktok-live";
import { fetchConfirmedCompletions } from "@/lib/daily-reports/confirmations";
import { metricsDepartmentForName } from "./types";

// --- Window (Manila UTC+8, period ending yesterday) -------------------------
//
// Byte-for-byte the TikTok sync convention (lib/tiktok/sync.ts resolveWindow): a
// rolling N-day span whose LAST day is yesterday in Asia/Manila, so every table in
// the OS agrees on what "yesterday" means. Default span 30 days, matching the
// TikTok default so the GMV the rollup reads covers the same month the sync lands.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function manilaDate(utcMs: number): string {
  return new Date(utcMs + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export interface RollupWindow {
  startDate: string; // inclusive first day (today - N), YYYY-MM-DD (Manila)
  endDate: string; // inclusive last day (yesterday), YYYY-MM-DD (Manila)
}

export function resolveRollupWindow(days = 30, nowMs: number = Date.now()): RollupWindow {
  const n = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
  const todayStartUtcMs = Math.floor((nowMs + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
  const startUtcMs = todayStartUtcMs - n * DAY_MS;
  return {
    startDate: manilaDate(startUtcMs),
    endDate: manilaDate(todayStartUtcMs - DAY_MS), // yesterday
  };
}

// "Today" in Manila — the reference date efficiency's on-time / throughput math
// uses. Same floor-to-day technique as the window above.
function todayManila(nowMs: number = Date.now()): string {
  const todayStartUtcMs = Math.floor((nowMs + MANILA_OFFSET_MS) / DAY_MS) * DAY_MS - MANILA_OFFSET_MS;
  return manilaDate(todayStartUtcMs);
}

// --- Public shapes ----------------------------------------------------------

export interface RollupRow {
  org_id: string;
  department_id: string | null; // null = org-level roll-up row
  department_name: string | null;
  gmv_impact: number;
  efficiency: number | null;
  quality_score: number | null;
  capacity_utilization: null; // always null — honest, until a definition exists
  period_start: string;
  period_end: string;
}

export interface RollupResult {
  status: "success" | "error";
  orgs: number; // orgs processed
  rowsUpserted: number; // department + org-level rows written
  window: RollupWindow;
  rows: RollupRow[]; // exactly what was written, for the route to echo
  warnings: string[]; // per-department / per-org isolated failures
  error?: string;
}

// --- Minimal typed DB surface (service role) for the direct reads/writes here
// (departments/tasks/users/organizations + the metrics_snapshots upsert). The live
// commerce read goes through lib/metrics/tiktok-live's own shim, not this one. We
// describe just what we touch — mirrors lib/tiktok/metric-entries.ts. -----------

interface FilterBuilder<Row> extends Promise<{ data: Row[] | null; error: unknown }> {
  select(cols: string): FilterBuilder<Row>;
  eq(col: string, val: string): FilterBuilder<Row>;
}
interface TableApi {
  select(cols: string): FilterBuilder<Record<string, unknown>>;
  upsert(
    rows: Record<string, unknown>[],
    opts: { onConflict: string }
  ): Promise<{ error: unknown }>;
}
interface RollupDb {
  from(table: string): TableApi;
}

function db(): RollupDb {
  return createServiceRoleClient() as unknown as RollupDb;
}

// --- Helpers ----------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

type DeptRow = { id: string; name: string };
type UserRow = { id: string; department_id: string | null };
type TaskRow = TaskLite & { assignee_id: string | null };

// --- Orchestrator -----------------------------------------------------------

// Fold every org's live rows into metrics_snapshots for the window. Optionally
// scoped to one org (the leadership "refresh" path) or all orgs (the machine
// trigger). Never throws for a single org OR a single department — each is
// isolated so one bad slice can't abort the run.
export async function rollupMetricsSnapshots(
  opts: { orgId?: string; nowMs?: number; windowDays?: number } = {}
): Promise<RollupResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const win = resolveRollupWindow(opts.windowDays ?? 30, nowMs);
  const today = todayManila(nowMs);
  const synced_at = new Date(nowMs).toISOString();
  const warnings: string[] = [];
  const written: RollupRow[] = [];
  let anyError = false;

  // Which orgs. A machine run spans them all; a scoped run touches only its own.
  let orgIds: string[];
  if (opts.orgId) {
    orgIds = [opts.orgId];
  } else {
    const { data, error } = await db().from("organizations").select("id");
    if (error) {
      return {
        status: "error",
        orgs: 0,
        rowsUpserted: 0,
        window: win,
        rows: [],
        warnings,
        error: `load organizations failed: ${JSON.stringify(error)}`,
      };
    }
    orgIds = (data ?? []).map((r) => str(r.id)).filter((v): v is string => v !== null);
  }

  // The confirmed-completion map is keyed by task_id (globally-unique UUIDs), so a
  // single fetch is safe to share across orgs — per-org lookups only ever hit that
  // org's own task ids. This is the SAME signal lib/metrics/signals.ts reads.
  let confirmed: Awaited<ReturnType<typeof fetchConfirmedCompletions>>;
  try {
    confirmed = await fetchConfirmedCompletions(
      db() as unknown as { from: (t: string) => any }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: "error",
      orgs: 0,
      rowsUpserted: 0,
      window: win,
      rows: [],
      warnings,
      error: `load confirmations failed: ${message}`,
    };
  }

  for (const org of orgIds) {
    try {
      // Org-scoped inputs (explicit org_id — RLS is bypassed under service role).
      // The live per-brand commerce series is read ONCE (getLiveDaysByBrand) and
      // feeds BOTH the windowed GMV sum and the quality completeness score, so there
      // is exactly one read of the one GMV source of truth.
      const [deptRes, taskRes, userRes, liveByBrand] = await Promise.all([
        db().from("departments").select("id, name").eq("org_id", org),
        db().from("tasks").select("id, status, due_date, assignee_id").eq("org_id", org),
        db().from("users").select("id, department_id").eq("org_id", org),
        getLiveDaysByBrand(
          createServiceRoleClient() as unknown as Parameters<typeof getLiveDaysByBrand>[0],
          org
        ),
      ]);

      if (deptRes.error) throw new Error(`departments: ${JSON.stringify(deptRes.error)}`);
      if (taskRes.error) throw new Error(`tasks: ${JSON.stringify(taskRes.error)}`);
      if (userRes.error) throw new Error(`users: ${JSON.stringify(userRes.error)}`);

      const departments = (deptRes.data ?? []) as unknown as DeptRow[];
      const tasks = (taskRes.data ?? []) as unknown as TaskRow[];
      const users = (userRes.data ?? []) as unknown as UserRow[];

      // GMV — the org's commerce revenue for the window, summed from
      // tiktok_shop_performance through the SAME range-aware helper every commerce
      // surface uses (sumOrgGmvWindow over the live per-brand series). This is the
      // ONE GMV source of truth: it reconciles with the Command Center by
      // construction. It is attributed to the department that owns commerce
      // (E-Commerce Ops) and rolled onto the org-level row from the same figure.
      const orgCommerceGmv = sumOrgGmvWindow(liveByBrand, win.startDate, win.endDate);

      // Commerce rows for the quality score — the SAME live series, folded into the
      // BpmRow shape via the shared brandDayToRow mapper (no second source, no
      // duplicated mapping). Quality is scored across all reported days, exactly as
      // lib/metrics/signals.ts computes it.
      const commerceRows: BpmRow[] = [];
      for (const [brandId, days] of liveByBrand) {
        for (const d of days) commerceRows.push(brandDayToRow(brandId, d));
      }

      // Per-department efficiency: attribute each task to its assignee's department
      // (the SAME rule as computeDepartmentEfficiency), then fold through the shared
      // efficiencyFrom. Tasks with no attributable department are excluded, never
      // zeroed.
      const deptByUser = new Map<string, string | null>();
      for (const u of users) deptByUser.set(u.id, u.department_id);
      const tasksByDept = new Map<string, TaskLite[]>();
      for (const t of tasks) {
        const deptId = t.assignee_id ? deptByUser.get(t.assignee_id) ?? null : null;
        if (!deptId) continue;
        const list = tasksByDept.get(deptId) ?? [];
        list.push({ id: t.id, status: t.status, due_date: t.due_date });
        tasksByDept.set(deptId, list);
      }
      const deptEfficiency = new Map<string, SignalValue>();
      for (const [deptId, deptTasks] of tasksByDept) {
        deptEfficiency.set(deptId, efficiencyFrom(deptTasks, confirmed, today));
      }

      // Org-level signals from the SAME pure functions.
      const orgEfficiency = efficiencyFrom(
        tasks.map((t) => ({ id: t.id, status: t.status, due_date: t.due_date })),
        confirmed,
        today
      );
      const orgQuality = qualityFrom(commerceRows);

      // Build the row set: one per department + one org-level roll-up. Commerce GMV
      // and commerce quality both belong to the department that owns commerce
      // (E-Commerce Ops); every other department has no commerce attribution, so its
      // GMV is a truthful 0 and its quality an honest NULL.
      const rows: RollupRow[] = [];
      for (const d of departments) {
        const slug = metricsDepartmentForName(d.name);
        const ownsCommerce = slug === "ecommerce";
        const eff = deptEfficiency.get(d.id);
        rows.push({
          org_id: org,
          department_id: d.id,
          department_name: d.name,
          gmv_impact: ownsCommerce ? orgCommerceGmv : 0,
          efficiency: eff && eff.value != null ? eff.value : null,
          quality_score: ownsCommerce && orgQuality.value != null ? orgQuality.value : null,
          capacity_utilization: null,
          period_start: win.startDate,
          period_end: win.endDate,
        });
      }
      // Org-level roll-up (department_id NULL): drives the signals sparkline + the
      // org-scope review. GMV rolls from the SAME commerce figure, so the org row
      // reconciles with the E-Commerce row and the Command Center by construction.
      rows.push({
        org_id: org,
        department_id: null,
        department_name: null,
        gmv_impact: orgCommerceGmv,
        efficiency: orgEfficiency.value,
        quality_score: orgQuality.value,
        capacity_utilization: null,
        period_start: win.startDate,
        period_end: win.endDate,
      });

      // Upsert each row in isolation — one bad department must not abort the org.
      for (const row of rows) {
        const { error } = await db()
          .from("metrics_snapshots")
          .upsert(
            [
              {
                org_id: row.org_id,
                department_id: row.department_id,
                gmv_impact: row.gmv_impact,
                efficiency: row.efficiency,
                quality_score: row.quality_score,
                capacity_utilization: row.capacity_utilization,
                period_start: row.period_start,
                period_end: row.period_end,
                source: "rollup",
                synced_at,
              },
            ],
            { onConflict: "org_id,department_id,period_start,period_end" }
          );
        if (error) {
          anyError = true;
          const label = row.department_name ?? "org-level";
          warnings.push(`org ${org} ${label}: upsert failed: ${JSON.stringify(error)}`);
          continue;
        }
        written.push(row);
      }

      console.info("[rollup] metrics_snapshots", {
        org,
        window: [win.startDate, win.endDate],
        departments: departments.length,
        rows: rows.length,
      });
    } catch (e) {
      anyError = true;
      const message = e instanceof Error ? e.message : String(e);
      warnings.push(`org ${org}: ${message}`);
      console.error("[rollup] org failed", { org, message });
    }
  }

  return {
    status: anyError ? "error" : "success",
    orgs: orgIds.length,
    rowsUpserted: written.length,
    window: win,
    rows: written,
    warnings,
  };
}
