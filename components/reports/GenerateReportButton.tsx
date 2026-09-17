"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type Option = { id: string; name: string };
type SnapshotRow = {
  department_id: string | null;
  gmv_impact: number;
  efficiency: number;
  quality_score: number;
  capacity_utilization: number;
};

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Generates a weekly report by rolling up the last 7 days of metrics_snapshots
// into a stored reports row. Deterministic aggregation for MVP; AI-drafted
// narrative reports are a V1.5 milestone (AI_AGENTS.md).
export function GenerateReportButton({
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);

    const end = new Date();
    const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const periodStart = isoDate(start);
    const periodEnd = isoDate(end);

    const { data } = await supabase
      .from("metrics_snapshots")
      .select("department_id, gmv_impact, efficiency, quality_score, capacity_utilization")
      .gte("period_end", periodStart);
    const snapshots = (data ?? []) as unknown as SnapshotRow[];

    if (snapshots.length === 0) {
      setError("No metrics recorded for the last 7 days yet.");
      setBusy(false);
      return;
    }

    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const byDept = new Map<string, SnapshotRow[]>();
    for (const s of snapshots) {
      const key = s.department_id ?? "unassigned";
      const list = byDept.get(key) ?? [];
      list.push(s);
      byDept.set(key, list);
    }

    const avg = (nums: number[]) =>
      nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : 0;

    const rows = Array.from(byDept.entries()).map(([deptId, list]) => ({
      department: deptName.get(deptId) ?? "Unassigned",
      gmv_impact: Math.round(list.reduce((a, b) => a + Number(b.gmv_impact), 0)),
      efficiency: avg(list.map((s) => Number(s.efficiency))),
      quality_score: avg(list.map((s) => Number(s.quality_score))),
      capacity_utilization: avg(list.map((s) => Number(s.capacity_utilization))),
    }));

    const totals = {
      gmv_impact: rows.reduce((a, b) => a + b.gmv_impact, 0),
      avg_efficiency: avg(rows.map((r) => r.efficiency)),
      avg_quality: avg(rows.map((r) => r.quality_score)),
      avg_capacity: avg(rows.map((r) => r.capacity_utilization)),
    };

    const content = { period_start: periodStart, period_end: periodEnd, rows, totals };

    const payload: Database["public"]["Tables"]["reports"]["Insert"] = {
      org_id: orgId,
      type: "weekly",
      title: `Weekly report — ${periodStart} to ${periodEnd}`,
      period_start: periodStart,
      period_end: periodEnd,
      generated_by: userId,
      content,
    };

    const { error: insertError } = await supabase.from("reports").insert(payload as never);
    setBusy(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end">
      <button
        onClick={generate}
        disabled={busy}
        className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-medium text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
      >
        {busy ? "Generating…" : "Generate weekly report"}
      </button>
      {error && <p className="mt-1 text-sm text-gold-400">{error}</p>}
    </div>
  );
}
