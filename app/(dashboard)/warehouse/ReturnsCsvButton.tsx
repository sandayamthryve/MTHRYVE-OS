"use client";

// Client-side CSV export for the returns case log. Mirrors the payroll/metrics
// export islands: the rows are computed on the server and passed down, and this
// only turns them into a downloadable file in the browser (no server round-trip).

type Row = {
  reported_date: string;
  brand: string;
  platform: string;
  order_ref: string;
  product_name: string;
  sku: string;
  units: number;
  value: number;
  currency: string;
  reason: string;
  fault: string;
  status: string;
  csr_owner: string;
  reported: string;
  resolved_date: string;
  note: string;
};

const HEADERS = [
  "reported_date",
  "brand",
  "platform",
  "order_ref",
  "product_name",
  "sku",
  "units",
  "value",
  "currency",
  "reason",
  "fault",
  "status",
  "csr_owner",
  "resolved_date",
  "note",
];

// Wrap a value in quotes and escape embedded quotes so values with commas don't
// shift columns.
function cell(v: string | number): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function ReturnsCsvButton({ rows, filename }: { rows: Row[]; filename: string }) {
  function download() {
    const lines = [HEADERS.map(cell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.reported_date,
          r.brand,
          r.platform,
          r.order_ref,
          r.product_name,
          r.sku,
          r.units,
          r.value,
          r.currency,
          r.reason,
          r.fault,
          r.status,
          r.csr_owner,
          r.resolved_date,
          r.note,
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
      Download Returns (CSV)
    </button>
  );
}
