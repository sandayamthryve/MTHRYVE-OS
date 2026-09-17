"use client";

// Client-side CSV export for the client roster (canonical `brands` records).
// Mirrors the payroll/DTR export islands: rows are computed on the server and
// passed down, and this only turns them into a downloadable file in the browser
// (no server round-trip). Columns cover the relationship fields Business
// Development owns.

type Row = {
  name: string;
  legal_name: string;
  category: string;
  account_tier: string;
  onboarding_status: string;
  status: string;
  primary_contact_name: string;
  primary_contact_email: string;
  primary_contact_phone: string;
  platform_focus: string;
  gmv_share: string;
};

const HEADERS = [
  "name",
  "legal_name",
  "category",
  "account_tier",
  "onboarding_status",
  "status",
  "primary_contact_name",
  "primary_contact_email",
  "primary_contact_phone",
  "platform_focus",
  "gmv_share",
];

// Wrap a value in quotes and escape embedded quotes so names with commas don't
// shift columns.
function cell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

export function ClientsCsvButton({ rows, filename }: { rows: Row[]; filename: string }) {
  function download() {
    const lines = [HEADERS.map(cell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.name,
          r.legal_name,
          r.category,
          r.account_tier,
          r.onboarding_status,
          r.status,
          r.primary_contact_name,
          r.primary_contact_email,
          r.primary_contact_phone,
          r.platform_focus,
          r.gmv_share,
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
      Download Clients (CSV)
    </button>
  );
}
