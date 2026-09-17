// lib/finance/expense-alerts.ts — the budget + expense-hygiene ALERT runners.
//
// These read real rows (budgets, expenses) and fan the right notifications to
// CEO + COO through the producers. They are BEST-EFFORT and never throw: an
// alert is a courtesy, never a gate on the action that triggered it, so every
// failure is swallowed. Nothing here moves money or advances a workflow.
//
// Callers: the expense server actions (encode / submit — RLS user client) and
// the advance_expense_stage executor (service-role client). Both can read
// budgets + expenses; the producers fan out through the service role internally,
// so recipients always resolve regardless of the caller's grant.

import { todayManila } from "@/lib/metrics/windows";
import {
  computeUtilization,
  type BudgetRow,
  type ExpenseForBudget,
} from "@/lib/finance/budgets";
import {
  notifyBudgetThreshold,
  notifyExpenseMissingDoc,
  notifyDuplicateReference,
} from "@/lib/notifications/producers";

type Shim = { from: (t: string) => any };

// A short scope label for a budget alert ("Brand · Acme" / "Department · Creative").
function scopeLabel(
  budget: BudgetRow,
  brandName: Map<string, string>,
  deptName: Map<string, string>
): string {
  if (budget.scope === "department") {
    return `Department · ${(budget.department_id && deptName.get(budget.department_id)) || "—"}`;
  }
  return `Brand · ${(budget.brand_id && brandName.get(budget.brand_id)) || "—"}`;
}

// Scan every budget in the org, compute annual + monthly utilization from the
// live expense ledger, and fire a budget_threshold notification for each budget
// that has crossed a band (80 / 90 / over). Returns how many budgets were
// checked and how many alerted. Never throws.
export async function runBudgetAlerts(
  db: Shim,
  orgId: string,
  nowMs: number = Date.now()
): Promise<{ checked: number; alerted: number }> {
  try {
    const refMonth = todayManila(nowMs).slice(0, 7);

    const [budgetsRes, expensesRes, brandsRes, deptsRes] = await Promise.all([
      db.from("budgets").select("*").eq("org_id", orgId),
      db
        .from("expenses")
        .select("gross_amount, transaction_date, brand_id, department_id, status, workflow_stage")
        .eq("org_id", orgId),
      db.from("brands").select("id, name").eq("org_id", orgId),
      db.from("departments").select("id, name").eq("org_id", orgId),
    ]);

    const budgets = ((budgetsRes.data ?? []) as BudgetRow[]).filter(Boolean);
    const expenses = (expensesRes.data ?? []) as ExpenseForBudget[];
    const brandName = new Map(
      ((brandsRes.data ?? []) as Array<{ id: string; name: string }>).map((b) => [b.id, b.name])
    );
    const deptName = new Map(
      ((deptsRes.data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name])
    );

    let alerted = 0;
    for (const budget of budgets) {
      const util = computeUtilization(budget, expenses, refMonth);
      if (!util.worstBand || !util.worstDimension) continue;
      const line = util.worstDimension === "annual" ? util.annual : util.monthly;
      const n = await notifyBudgetThreshold({
        orgId,
        budgetId: budget.id,
        scopeLabel: scopeLabel(budget, brandName, deptName),
        band: util.worstBand,
        dimension: util.worstDimension,
        pct: line.pct,
        utilized: line.utilized,
        budget: line.budget,
        remaining: line.remaining,
      });
      if (n > 0) alerted += 1;
    }
    return { checked: budgets.length, alerted };
  } catch {
    return { checked: 0, alerted: 0 };
  }
}

// Check one expense's hygiene at encode / submit time: a missing supporting
// reference (no reference_number on file) and a duplicate reference_number
// already used by another expense in the org. Fires the matching notifications
// to CEO + COO. Returns which flags fired. Never throws.
export async function checkExpenseHygiene(
  db: Shim,
  orgId: string,
  expense: {
    id: string;
    expenseLabel: string;
    reference_number: string | null;
    amountLabel?: string | null;
  }
): Promise<{ missingDoc: boolean; duplicateReference: boolean }> {
  const result = { missingDoc: false, duplicateReference: false };
  try {
    const ref = (expense.reference_number ?? "").trim();

    if (!ref) {
      await notifyExpenseMissingDoc({
        orgId,
        expenseId: expense.id,
        expenseLabel: expense.expenseLabel,
        amountLabel: expense.amountLabel ?? null,
      });
      result.missingDoc = true;
      return result;
    }

    // Duplicate: any OTHER expense in the org carrying the same reference.
    const { data } = await db
      .from("expenses")
      .select("id")
      .eq("org_id", orgId)
      .eq("reference_number", ref)
      .neq("id", expense.id);
    const others = ((data ?? []) as Array<{ id: string }>).length;
    if (others > 0) {
      await notifyDuplicateReference({
        orgId,
        expenseId: expense.id,
        expenseLabel: expense.expenseLabel,
        referenceNumber: ref,
        otherCount: others,
      });
      result.duplicateReference = true;
    }
  } catch {
    // Best effort — hygiene alerts never block the expense action.
  }
  return result;
}
