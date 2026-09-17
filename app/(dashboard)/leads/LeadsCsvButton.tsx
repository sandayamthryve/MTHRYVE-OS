"use client";

// Client-side CSV export for leads. Mirrors the payroll/metrics export islands:
// the rows are computed on the server and passed down, and this only turns them
// into a downloadable file in the browser (no server round-trip).

type Row = {
  name: string;
  company: string;
  email: string;
  phone: string;
  source: string;
  department: string;
  stage: string;
  value: string;
  notes: string;
};

// Column order is fixed by the leads export spec.
const HEADERS = [
  "name",
  "company",
  "email",
  "phone",
  "source",
  "department",
  "stage",
  "value",
  "notes",
];

// Wrap a value in quotes and escape embedded quotes so names with commas don't
// shift columns.
function cell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function LeadsCsvButton({ rows, filename }: { rows: Row[]; filename: string }) {
  function download() {
    const lines = [HEADERS.map(cell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.name,
          r.company,
          r.email,
          r.phone,
          r.source,
          r.department,
          r.stage,
          r.value,
          r.notes,
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
      Download Leads (CSV)
    </button>
  );
}
