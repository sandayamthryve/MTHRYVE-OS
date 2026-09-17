"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setBudget, scanBudgets, type BudgetActionResult } from "./actions";

export type Option = { id: string; name: string };

// COO-only form to set an annual and/or monthly budget for a brand or department.
export function SetBudgetForm({
  brands,
  departments,
  defaultPeriod,
}: {
  brands: Option[];
  departments: Option[];
  defaultPeriod: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("brand");

  function onSubmit(formData: FormData) {
    setMsg(null);
    setError(null);
    startTransition(async () => {
      const res: BudgetActionResult = await setBudget(formData);
      if (res.ok) {
        setMsg(res.message ?? "Saved.");
        router.refresh();
      } else {
        setError(res.error ?? "Could not save the budget.");
      }
    });
  }

  const field =
    "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

  return (
    <form action={onSubmit} className="grid gap-3 sm:grid-cols-3">
      <label className="text-[11px] text-ink-muted">
        Scope
        <select name="scope" value={scope} onChange={(e) => setScope(e.target.value)} className={field}>
          <option value="brand">brand</option>
          <option value="department">department</option>
        </select>
      </label>
      {scope === "brand" ? (
        <label className="text-[11px] text-ink-muted">
          Brand
          <select name="brand_id" className={field} defaultValue="">
            <option value="">— Pick a brand —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="text-[11px] text-ink-muted">
          Department
          <select name="department_id" className={field} defaultValue="">
            <option value="">— Pick a department —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="text-[11px] text-ink-muted">
        Period (year)
        <input name="period" required defaultValue={defaultPeriod} placeholder="2026" className={field} />
      </label>
      <label className="text-[11px] text-ink-muted">
        Annual budget (PHP)
        <input name="annual_budget" type="number" step="0.01" placeholder="e.g. 1200000" className={field} />
      </label>
      <label className="text-[11px] text-ink-muted">
        Monthly budget (PHP)
        <input name="monthly_budget" type="number" step="0.01" placeholder="e.g. 100000" className={field} />
      </label>
      <div className="flex items-end">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Set budget"}
        </button>
      </div>
      <div className="sm:col-span-3">
        {error && <span className="text-xs text-red-400">{error}</span>}
        {msg && <span className="text-xs text-teal-300">{msg}</span>}
      </div>
    </form>
  );
}

// Manual re-scan button — fires 80/90/exceeded alerts to CEO + COO.
export function ScanBudgetsButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function run() {
    setMsg(null);
    startTransition(async () => {
      const res = await scanBudgets();
      setMsg(res.message ?? null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md bg-charcoal-800 px-3 py-1.5 text-sm font-semibold text-teal-300 hover:bg-charcoal-700 disabled:opacity-60"
      >
        {pending ? "Scanning…" : "Scan budgets now"}
      </button>
      {msg && <p className="max-w-[22rem] text-right text-xs text-ink-muted">{msg}</p>}
    </div>
  );
}
