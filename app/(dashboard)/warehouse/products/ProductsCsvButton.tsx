"use client";

// Client-side CSV export for the product master. Mirrors the returns/creators
// export islands: rows are computed on the server and passed down, and this only
// turns them into a downloadable file in the browser (no server round-trip). The
// column order matches the import header, so an exported file re-imports cleanly.

type Row = {
  brand: string;
  sku: string;
  product_name: string;
  variant: string;
  barcode: string;
  warehouse_location: string;
  category: string;
  cost: string;
  selling_price: string;
  reorder_point: string;
  status: string;
  notes: string;
};

const HEADERS = [
  "brand",
  "sku",
  "product_name",
  "variant",
  "barcode",
  "warehouse_location",
  "category",
  "cost",
  "selling_price",
  "reorder_point",
  "status",
  "notes",
];

function cell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function ProductsCsvButton({ rows, filename }: { rows: Row[]; filename: string }) {
  function download() {
    const lines = [HEADERS.map(cell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.brand,
          r.sku,
          r.product_name,
          r.variant,
          r.barcode,
          r.warehouse_location,
          r.category,
          r.cost,
          r.selling_price,
          r.reorder_point,
          r.status,
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
      Download Products (CSV)
    </button>
  );
}
