import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass, Badge } from "@/components/ui";
import { requireModule, requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import Link from "next/link";

export const dynamic = "force-dynamic";

type CategoryRow = {
  id: string;
  name: string;
  description?: string;
  category_group: "Administrative" | "Marketing" | "Operations" | "Human Resources" | "Finance";
  gl_code?: string;
  cost_center?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const DEFAULT_GROUPS = ["Administrative", "Marketing", "Operations", "Human Resources", "Finance"] as const;

async function loadCategories(orgId: string) {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase
    .from("expense_categories")
    .select("*")
    .eq("org_id", orgId)
    .order("category_group", { ascending: true })
    .order("name", { ascending: true });
  return (data ?? []) as CategoryRow[];
}

function groupCounts(categories: CategoryRow[]) {
  return DEFAULT_GROUPS.reduce((acc, g) => {
    acc[g] = categories.filter((c) => c.category_group === g && c.is_active).length;
    return acc;
  }, {} as Record<string, number>);
}

export default async function CategoriesPage() {
  // Guarded by the module, like every sibling in the Money group. It was
  // requireRole(["ceo","coo"]), which no preview scope satisfies, so the
  // page was unopenable for the very role that needs it. Writes stay
  // leadership-only through RLS on the rows.
  const profile = await requireModule("/finance/expenses/categories");
  const categories = await loadCategories(profile.org_id);
  const counts = groupCounts(categories);
  const activeCount = categories.filter((c) => c.is_active).length;

  return (
    <AppShell breadcrumb={["Finance", "Expenses", "Categories"]} profile={profile}>
      <PageHeader
        title="Expense Categories"
        subtitle={`${categories.length} categories · ${activeCount} active across ${DEFAULT_GROUPS.length} groups`}
        action={
          <Link
            href="/finance/expenses/categories/new"
            className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
          >
            + Add Category
          </Link>
        }
      />

      {/* Group Summary */}
      <SectionCard title="Category Groups" className="mb-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {DEFAULT_GROUPS.map((group) => (
            <div key={group} className="p-4 rounded-lg bg-charcoal-800/50 border border-charcoal-700">
              <p className="text-sm text-ink-muted">{group}</p>
              <p className="text-2xl font-bold font-mono text-ink">{counts[group] ?? 0}</p>
              <p className="text-xs text-ink-dim">active</p>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Categories Table */}
      <SectionCard title="All Categories">
        {categories.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-ink-muted mb-4">No categories configured. Default groups will be seeded on first use.</p>
            <Link
              href="/finance/expenses/categories/new"
              className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink-muted hover:text-ink"
            >
              Create First Category
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap gap-3">
              <input
                type="text"
                placeholder="Search categories..."
                className="max-w-xs rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink placeholder:text-ink-dim focus:border-teal-500 focus:outline-none"
                aria-label="Search categories"
              />
              <select
                className="max-w-[180px] rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink focus:border-teal-500 focus:outline-none"
                aria-label="Filter by group"
              >
                <option value="">All Groups</option>
                {DEFAULT_GROUPS.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
              <select
                className="max-w-[140px] rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-2 text-sm text-ink focus:border-teal-500 focus:outline-none"
                aria-label="Filter by status"
              >
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <TableShell
              columns={[
                "Name",
                "Group",
                "GL Code",
                "Cost Center",
                "Status",
                "Actions",
              ]}
            >
              {categories.map((c) => (
                <tr key={c.id} className={rowClass}>
                  <td className="p-3 font-medium text-ink">{c.name}</td>
                  <td className="p-3">
                    <Badge tone="muted">{c.category_group}</Badge>
                  </td>
                  <td className="p-3 font-mono text-sm text-ink-muted">{c.gl_code ?? "—"}</td>
                  <td className="p-3 font-mono text-sm text-ink-muted">{c.cost_center ?? "—"}</td>
                  <td className="p-3">
                    <Badge tone={c.is_active ? "success" : "destructive"}>
                      {c.is_active ? "Active" : "Disabled"}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/finance/expenses/categories/${c.id}`}
                        className="rounded-lg border border-charcoal-700 bg-charcoal-850 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
                      >
                        View
                      </Link>
                      <Link
                        href={`/finance/expenses/categories/${c.id}/edit`}
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

      {/* Admin Note */}
      <SectionCard title="Configuration Notes" className="mt-6">
        <ul className="space-y-2 text-sm text-ink-muted">
          <li>• Categories map to GL codes and cost centers for accounting integration</li>
          <li>• Disable (don't delete) categories to preserve historical expense data</li>
          <li>• Default groups: {DEFAULT_GROUPS.join(", ")} — add custom groups as needed</li>
          <li>• One-time vendor entries in ledger can use ad-hoc category selection</li>
        </ul>
      </SectionCard>
    </AppShell>
  );
}