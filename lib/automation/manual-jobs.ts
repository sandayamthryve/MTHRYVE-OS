// lib/automation/manual-jobs.ts — the MANUAL-OVERRIDE registry.
//
// PROBLEM this solves: every automation job (products sync, metrics rollup, …)
// is driven by automation's Schedule node with the AUTOMATION_API_KEY bearer. That key
// is marked Sensitive in Vercel and cannot be revealed, so NO human in the
// company can fire a job by hand. Result: the products sync shipped and was
// never once run — products sat at 0 API rows for weeks.
//
// This module is the human path. It REUSES the exact same work functions the
// bearer routes call (lib/tiktok/products · lib/metrics/rollup) — it does not
// duplicate the sync logic and it does not touch the bearer routes. It only adds
// a session-authenticated way to invoke that same work and to report, honestly,
// what each run did. The AUTOMATION_API_KEY is never referenced here and never
// reaches the client.
//
// The gate (leadership-only) + audit + rate-limit live in the caller
// (app/api/admin/automation/run) — this module is pure job wiring.

import { createServiceRoleClient } from "@/lib/supabase/service";
import { syncProducts } from "@/lib/tiktok/products";
import { isTikTokConfigured } from "@/lib/tiktok/config";
import { rollupMetricsSnapshots } from "@/lib/metrics/rollup";

// The stable job identifiers the UI and the admin route speak. Adding a job is a
// single entry in JOBS below; the panel renders whatever is registered.
export type ManualJobKey = "products-sync" | "metrics-rollup";

// The normalized outcome every job returns. Counts are the honest breakdown of
// what the run did — never a bare "Success". A job that has no natural notion of
// one of these leaves it undefined and the UI simply omits that chip.
export interface ManualRunResult {
  ok: boolean;
  created?: number;
  updated?: number;
  skipped?: number;
  // Non-fatal, per-item failures (a shop that auth-failed, a department upsert
  // that errored). The run as a whole can still be ok:true with errors present —
  // failure-isolation is by design in the underlying jobs.
  errors: string[];
  // One short human line summarizing the run, for the audit detail + a fallback
  // when there are no counts to show.
  summary: string;
}

export interface ManualJob {
  key: ManualJobKey;
  name: string;
  description: string;
  // Read the REAL last-successful-run timestamp from the data the job writes —
  // max(synced_at) on products, max(created_at) on metrics_snapshots — scoped to
  // the caller's org. Null when the job has never landed a row. No fabrication:
  // "never" is shown as "never".
  lastRun: (orgId: string) => Promise<string | null>;
  // Invoke the SAME work function the bearer route calls, then normalize.
  run: (orgId: string) => Promise<ManualRunResult>;
}

// action_audit / max-timestamp reads go through the app's cast shim, as the rest
// of the OS does for not-yet-generated table types.
type Shim = { from: (t: string) => any };

// max(<col>) for the caller's org, or null. Best-effort: a read failure returns
// null ("unknown") rather than throwing — a missing timestamp must not break the
// panel.
async function maxTimestamp(table: string, col: string, orgId: string): Promise<string | null> {
  try {
    const db = createServiceRoleClient() as unknown as Shim;
    const { data, error } = await db
      .from(table)
      .select(col)
      .eq("org_id", orgId)
      .not(col, "is", null)
      .order(col, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const v = (data as Record<string, unknown>)[col];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export const JOBS: Record<ManualJobKey, ManualJob> = {
  "products-sync": {
    key: "products-sync",
    name: "Products sync (TikTok)",
    description:
      "Pull the TikTok Product catalogue into the products master (SKUs, names, prices). Additive identity only — warehouse-managed fields are never touched.",
    lastRun: (orgId) => maxTimestamp("products", "synced_at", orgId),
    run: async (): Promise<ManualRunResult> => {
      if (!isTikTokConfigured()) {
        return { ok: false, errors: ["TikTok is not configured on this deployment."], summary: "TikTok not configured" };
      }
      // syncProducts walks every ACTIVE shop across all orgs (service-role, same
      // as the bearer path) and is failure-isolated per shop.
      const s = await syncProducts();
      const errors = s.results.filter((r) => !r.ok).map((r) => `${r.shop_id}: ${(r as { error: string }).error}`);
      return {
        ok: s.shops_ok === s.shops_total,
        created: s.rows_created,
        updated: s.rows_updated,
        skipped: s.rows_skipped,
        errors,
        summary: `${s.shops_ok}/${s.shops_total} shop(s): ${s.rows_created} created, ${s.rows_updated} updated, ${s.rows_skipped} skipped`,
      };
    },
  },
  "metrics-rollup": {
    key: "metrics-rollup",
    name: "Department metrics rollup",
    description:
      "Fold the OS's live rows into one metrics_snapshots row per department + an org-level row. Idempotent — re-running refreshes rows in place.",
    lastRun: (orgId) => maxTimestamp("metrics_snapshots", "created_at", orgId),
    run: async (orgId): Promise<ManualRunResult> => {
      // Scope the rollup to the caller's own org (the leadership "refresh" path),
      // exactly as the metrics-rollup route's session branch does.
      const r = await rollupMetricsSnapshots({ orgId });
      // The rollup is an idempotent upsert, so it has no created/updated split —
      // it reports rows written and per-slice warnings. Map rows-written onto
      // "updated" (refreshed in place) so the panel shows a real number.
      return {
        ok: r.status === "success",
        updated: r.rowsUpserted,
        errors: r.warnings,
        summary: `${r.rowsUpserted} snapshot row(s) written for window ${r.window.startDate} → ${r.window.endDate}`,
      };
    },
  },
};

export function getJob(key: string): ManualJob | null {
  return (JOBS as Record<string, ManualJob>)[key] ?? null;
}

export const JOB_LIST: ManualJob[] = Object.values(JOBS);
