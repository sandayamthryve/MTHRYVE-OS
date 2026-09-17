import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass, Badge } from "@/components/ui";
import { requireModule, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

type VendorRow = {
  id: string;
  name: string;
  contact_person?: string;
  address?: string;
  tin?: string;
  vat_registered: boolean;
  payment_terms?: string;
  preferred_method?: string;
  bank_details?: string;
  is_active: boolean;
  is_one_time: boolean;
  created_at: string;
  updated_at: string;
};

async function loadVendors(orgId: string) {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("expense_vendors")
    .select("*")
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  return (data ?? []) as VendorRow[];
}

export default async function VendorsPage() {
  // Guarded by the module, like every sibling in the Money group. It was
  // requireRole(["ceo","coo"]), which no preview scope satisfies, so the
  // page was unopenable for the very role that needs it. Writes stay
  // leadership-only through RLS on the rows.
  const profile = await requireModule("/finance/expenses/vendors");
  const vendors = await loadVendors(profile.org_id);

  const activeCount = vendors.filter((v) => v.is_active).length;
  const oneTimeCount = vendors.filter((v) => v.is_one_time).length;

  return (
    <AppShell breadcrumb={["Finance", "Expenses", "Vendors"]} profile={profile}>
      <PageHeader
        title="Vendor Master"
        subtitle={`${vendors.length} vendors · ${activeCount} active · ${oneTimeCount} one-time`}
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/finance/expenses/vendors/new"
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              + Add Vendor
            </Link>
            <Link
              href="/finance/expenses/vendors/import"
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              Import CSV
            </Link>
          </div>
        }
      />

      <SectionCard title="All Vendors">
        {vendors.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-ink-muted mb-4">No vendors configured yet.</p>
            <Link
              href="/finance/expenses/vendors/new"
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              Create First Vendor
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <input
                type="text"
                placeholder="Search vendors by name, contact, TIN..."
                className="max-w-xs rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500 focus:outline-none"
                aria-label="Search vendors"
              />
            </div>
            <TableShell
              columns={[
                "Name",
                "Contact Person",
                "TIN",
                "VAT Registered",
                "Payment Terms",
                "Preferred Method",
                "Type",
                "Status",
                "Actions",
              ]}
            >
              {vendors.map((v) => (
                <tr key={v.id} className={rowClass}>
                  <td className="p-3 font-medium text-ink">{v.name}</td>
                  <td className="p-3 text-ink-muted">{v.contact_person ?? "—"}</td>
                  <td className="p-3 font-mono text-sm text-ink-muted">{v.tin ?? "—"}</td>
                  <td className="p-3">
                    <Badge tone={v.vat_registered ? "success" : "muted"}>
                      {v.vat_registered ? "Yes" : "No"}
                    </Badge>
                  </td>
                  <td className="p-3 text-ink-muted">{v.payment_terms ?? "—"}</td>
                  <td className="p-3 text-ink-muted">{v.preferred_method ?? "—"}</td>
                  <td className="p-3">
                    <Badge tone={v.is_one_time ? "warning" : "muted"}>
                      {v.is_one_time ? "One-time" : "Recurring"}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Badge tone={v.is_active ? "success" : "destructive"}>
                      {v.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/finance/expenses/vendors/${v.id}`}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                      >
                        View
                      </Link>
                      <Link
                        href={`/finance/expenses/vendors/${v.id}/edit`}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                      >
                        Edit
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </TableShell>
          </>
        )}
      </SectionCard>

      {/* Quick Stats */}
      <SectionCard title="Vendor Analytics" className="mt-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-teal-400">{vendors.length}</p>
            <p className="text-sm text-ink-muted">Total Vendors</p>
          </div>
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-green-400">{activeCount}</p>
            <p className="text-sm text-ink-muted">Active</p>
          </div>
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-amber-400">{oneTimeCount}</p>
            <p className="text-sm text-ink-muted">One-time</p>
          </div>
          <div className="p-4 rounded-lg bg-charcoal-800/50">
            <p className="text-2xl font-bold font-mono text-red-400">{vendors.length - activeCount}</p>
            <p className="text-sm text-ink-muted">Inactive</p>
          </div>
        </div>
      </SectionCard>
    </AppShell>
  );
}