"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runBudgetAlerts } from "@/lib/finance/expense-alerts";

// Budget administration — COO ONLY (budgets write RLS is coo-only). The COO sets
// an annual and/or monthly budget per brand or department for a fiscal year.
// Setting a budget re-scans utilization so a newly-tightened budget can fire its
// threshold alert immediately.

type Shim = { from: (t: string) => any };

export interface BudgetActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

function str(v: FormDataEntryValue | null): string {
  return String(v ?? "").trim();
}
function numOrNull(v: FormDataEntryValue | null): number | null {
  const s = str(v);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Set (create or update) a budget for a scope + period. Idempotent: an existing
// budget for the same (scope, target, period) is updated rather than duplicated.
export async function setBudget(formData: FormData): Promise<BudgetActionResult> {
  const profile = (await requireRole(["coo"])) as unknown as { id: string; org_id: string };
  const db = createServerSupabaseClient() as unknown as Shim;

  const scope = str(formData.get("scope")) === "department" ? "department" : "brand";
  const brand_id = scope === "brand" ? str(formData.get("brand_id")) || null : null;
  const department_id = scope === "department" ? str(formData.get("department_id")) || null : null;
  const period = str(formData.get("period"));
  const annual_budget = numOrNull(formData.get("annual_budget"));
  const monthly_budget = numOrNull(formData.get("monthly_budget"));

  if (scope === "brand" && !brand_id) return { ok: false, error: "Pick a brand for a brand budget." };
  if (scope === "department" && !department_id) {
    return { ok: false, error: "Pick a department for a department budget." };
  }
  if (!/^\d{4}$/.test(period)) return { ok: false, error: "Period must be a 4-digit year, e.g. 2026." };
  if (annual_budget == null && monthly_budget == null) {
    return { ok: false, error: "Set an annual and/or monthly amount." };
  }

  // Find an existing budget for this exact scope + period to update in place.
  let query = db
    .from("budgets")
    .select("id")
    .eq("org_id", profile.org_id)
    .eq("scope", scope)
    .eq("period", period);
  query = scope === "brand" ? query.eq("brand_id", brand_id) : query.eq("department_id", department_id);
  const { data: existing } = await query.maybeSingle();
  const existingId = (existing as { id?: string } | null)?.id ?? null;

  const now = new Date().toISOString();
  if (existingId) {
    const { error } = await db
      .from("budgets")
      .update({ annual_budget, monthly_budget, updated_at: now })
      .eq("id", existingId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await db.from("budgets").insert({
      org_id: profile.org_id,
      created_by: profile.id,
      scope,
      brand_id,
      department_id,
      period,
      annual_budget,
      monthly_budget,
    });
    if (error) return { ok: false, error: error.message };
  }

  // Re-scan so a newly-set/tightened budget fires its threshold alert now.
  await runBudgetAlerts(db, profile.org_id);

  revalidatePath("/finance/expenses/budgets");
  return { ok: true, message: existingId ? "Budget updated." : "Budget set." };
}

// Manual re-scan of every budget's utilization (button). COO/CEO.
export async function scanBudgets(): Promise<BudgetActionResult> {
  const profile = (await requireRole(["ceo", "coo"])) as unknown as { org_id: string };
  const db = createServerSupabaseClient() as unknown as Shim;
  const { checked, alerted } = await runBudgetAlerts(db, profile.org_id);
  revalidatePath("/finance/expenses/budgets");
  return {
    ok: true,
    message: `Scanned ${checked} budget${checked === 1 ? "" : "s"} — ${alerted} alert${alerted === 1 ? "" : "s"} fired to CEO + COO.`,
  };
}
