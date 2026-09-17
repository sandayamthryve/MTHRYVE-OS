"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type Option = { id: string; name: string };

// Manual metric entry (ceo/coo/department_head). Automated ingestion (TikTok /
// Shopee via Zapier) is a V2 milestone — for MVP a manager records the weekly
// universal metric set (D-004) per department here.
export function MetricEntryForm({
  orgId,
  userId,
  departments,
}: {
  orgId: string;
  userId: string;
  departments: Option[];
}) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [gmv, setGmv] = useState("");
  const [eff, setEff] = useState("");
  const [qual, setQual] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!departmentId || !periodStart || !periodEnd) {
      setError("Department and period are required.");
      return;
    }
    setBusy(true);
    setError(null);

    const payload: Database["public"]["Tables"]["metrics_snapshots"]["Insert"] = {
      org_id: orgId,
      department_id: departmentId,
      gmv_impact: Number(gmv) || 0,
      efficiency: Number(eff) || 0,
      quality_score: Number(qual) || 0,
      capacity_utilization: Number(cap) || 0,
      period_start: periodStart,
      period_end: periodEnd,
      created_by: userId,
    };

    const { error: insertError } = await supabase
      .from("metrics_snapshots")
      .insert(payload as never);
    setBusy(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setGmv("");
    setEff("");
    setQual("");
    setCap("");
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink"
      >
        + Record metrics
      </button>
    );
  }

  const numField = (
    label: string,
    value: string,
    set: (v: string) => void,
    suffix?: string
  ) => (
    <label className="text-xs text-ink-muted">
      {label}
      {suffix ? ` (${suffix})` : ""}
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
      />
    </label>
  );

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-4">
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-xs text-ink-muted">
          Department
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
          >
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-muted">
          Period start
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
          />
        </label>
        <label className="text-xs text-ink-muted">
          Period end
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-sm text-ink"
          />
        </label>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {numField("GMV impact", gmv, setGmv)}
        {numField("Efficiency", eff, setEff, "0-100")}
        {numField("Quality", qual, setQual, "0-100")}
        {numField("Capacity", cap, setCap, "0-100")}
      </div>
      {error && <p className="mb-2 text-sm text-gold-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save metrics"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
