"use client";

// Client-side "download a blank template" button for the Tasks/Projects bulk
// import. Mirrors the export CsvButton islands (brands/leads/metrics) — it turns
// a fixed header row plus one example row into a downloadable .csv in the
// browser, with no server round-trip. The example row shows the expected shape
// (matched-by-name columns, date format) so leadership can fill it in a
// spreadsheet and paste/upload it straight back into the import control.

// Wrap a value in quotes and escape embedded quotes so values with commas don't
// shift columns.
function cell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function TemplateCsvButton({
  headers,
  example,
  filename,
  label,
}: {
  headers: string[];
  example: string[];
  filename: string;
  label: string;
}) {
  function download() {
    const csv = [headers.map(cell).join(","), example.map(cell).join(",")].join("\r\n");
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
      {label}
    </button>
  );
}
