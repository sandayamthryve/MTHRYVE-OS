"use client";

// Client-side CSV export for the Team DTR. Mirrors the payroll ExportCsvButton
// island: the rows are computed on the server and passed down, and this only
// turns them into a downloadable file in the browser (no server round-trip).

type Row = {
  email: string;
  full_name: string;
  work_date: string;
  status: string;
  clock_in: string;
  clock_out: string;
  note: string;
};

// Column order is fixed by the DTR spec.
const HEADERS = ["email", "full_name", "work_date", "status", "clock_in", "clock_out", "note"];

// Wrap a value in quotes and escape embedded quotes so notes/names with commas
// don't shift columns.
function cell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function DtrCsvButton({ rows, filename }: { rows: Row[]; filename: string }) {
  function download() {
    const lines = [HEADERS.map(cell).join(",")];
    for (const r of rows) {
      lines.push(
        [r.email, r.full_name, r.work_date, r.status, r.clock_in, r.clock_out, r.note]
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
      className="rounded-md bg-charcoal-800 px-2.5 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
    >
      Download DTR (CSV)
    </button>
  );
}
