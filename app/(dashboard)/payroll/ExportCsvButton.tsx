"use client";

// Client-side CSV export for the payroll register. Kept as a thin island so the
// register table itself can stay a server component — the rows are passed down
// already computed, and this only turns them into a downloadable file in the
// browser (no server round-trip, no salary data leaving the page).

type Row = {
  full_name: string;
  pay_type: string;
  base: number;
  days_present: number;
  approved_leave?: number;
  late_minutes?: number;
  undertime_minutes?: number;
  overtime_minutes?: number;
  holiday_duty?: number;
  rest_day_duty?: number;
  allowance: number;
  deductions: number;
  gross: number;
  net: number;
};

const HEADERS = [
  "Employee",
  "Pay basis",
  "Base",
  "Days worked",
  "Approved leave",
  "Late (min)",
  "Undertime (min)",
  "Overtime (min)",
  "Holiday duty",
  "Rest day duty",
  "Allowance",
  "Deductions",
  "Gross",
  "Net",
];

// Wrap a value in quotes and escape embedded quotes so names with commas don't
// shift columns.
function cell(v: string | number): string {
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function ExportCsvButton({ rows, filename }: { rows: Row[]; filename: string }) {
  function download() {
    const lines = [HEADERS.map(cell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.full_name,
          r.pay_type,
          r.base,
          r.days_present,
          r.approved_leave ?? 0,
          r.late_minutes ?? 0,
          r.undertime_minutes ?? 0,
          r.overtime_minutes ?? 0,
          r.holiday_duty ?? 0,
          r.rest_day_duty ?? 0,
          r.allowance,
          r.deductions,
          r.gross,
          r.net,
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
      Export CSV
    </button>
  );
}
