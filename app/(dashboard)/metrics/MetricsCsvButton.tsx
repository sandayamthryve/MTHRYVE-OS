"use client";

// Client-side CSV export for metrics snapshots. Mirrors the payroll/DTR export
// islands: the rows are computed on the server and passed down, and this only
// turns them into a downloadable file in the browser (no server round-trip).

type Row = {
  department: string;
  period_start: string;
  period_end: string;
  efficiency: number;
  quality_score: number;
  capacity_utilization: number;
  gmv_impact: number;
};

// Column order is fixed by the metrics export spec.
const HEADERS = [
  "department",
  "period_start",
  "period_end",
  "efficiency",
  "quality_score",
  "capacity_utilization",
  "gmv_impact",
];

// Wrap a value in quotes and escape embedded quotes so names with commas don't
// shift columns.
function cell(v: string | number): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function MetricsCsvButton({ rows, filename }: { rows: Row[]; filename: string }) {
  function download() {
    const lines = [HEADERS.map(cell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.department,
          r.period_start,
          r.period_end,
          r.efficiency,
          r.quality_score,
          r.capacity_utilization,
          r.gmv_impact,
        ]
          .map(cell)
          .join(",")
      );
    }
    const csv = lines.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
    >
      Download Metrics (CSV)
    </button>
  );
}
