import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard } from "@/components/ui";
import { requireModule } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getDashboard, getUserNames } from "@/lib/metrics/data";
import {
  isDepartment,
  DEPARTMENT_LABELS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type Department,
} from "@/lib/metrics/types";
import {
  parsePreset,
  parseCompare,
  resolvePreset,
  resolveCompare,
  isValidDate,
  type Range,
} from "@/lib/metrics/dates";
import { MetricCard } from "../_components/MetricCard";
import { AccountHealthPanel } from "../_components/AccountHealthPanel";
import { DateRangeControls } from "../_components/DateRangeControls";
import { EncodePanel, type EncodeMetric } from "../_components/EncodePanel";
import { QuickEntryLauncher } from "@/components/quick-entry/QuickEntryLauncher";

export const dynamic = "force-dynamic";

type Search = {
  preset?: string;
  period_start?: string;
  period_end?: string;
  compare?: string;
  brand_id?: string;
};

// Per-department Metrics / Data Analytics dashboard. Same component powers all
// five departments — the [department] segment selects the catalog slice. Cards
// are grouped by category; account_health renders as a compliance panel.
export default async function DepartmentAnalyticsPage({
  params,
  searchParams,
}: {
  params: { department: string };
  searchParams: Search;
}) {
  if (!isDepartment(params.department)) notFound();
  const department = params.department as Department;

  const profile = await requireModule(`/analytics/${department}`);
  const canApprove =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";

  // The metrics floor is a DAILY grain — Quick-Entry writes a single-day row
  // (period_start = period_end = the chosen day). Default this dashboard to
  // "today" so a value just recorded through Quick-Entry surfaces immediately;
  // the range presets remain one click away for trend views.
  const preset = parsePreset(searchParams.preset, "today");
  const compareMode = parseCompare(searchParams.compare);
  const range: Range =
    isValidDate(searchParams.period_start) && isValidDate(searchParams.period_end)
      ? { start: searchParams.period_start, end: searchParams.period_end }
      : resolvePreset(preset, new Date(), {
          start: searchParams.period_start,
          end: searchParams.period_end,
        });
  const compareRange = resolveCompare(range, compareMode);
  const brandId =
    searchParams.brand_id && searchParams.brand_id !== "shop" ? searchParams.brand_id : null;

  const supabase = createServerSupabaseClient();
  const [brandsRes, userNames] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    getUserNames(supabase),
  ]);
  const brands = ((brandsRes.data ?? []) as unknown as { id: string; name: string }[]) ?? [];

  const data = await getDashboard(supabase, {
    department,
    brandId,
    range,
    compareRange,
    userNames,
  });

  const exportParams = new URLSearchParams({
    department,
    period_start: range.start,
    period_end: range.end,
  });
  if (brandId) exportParams.set("brand_id", brandId);
  const exportHref = `/api/metrics/export?${exportParams.toString()}`;

  const encodeMetrics: EncodeMetric[] = data.metrics
    .filter((m) => !m.formula)
    .map((m) => ({
      metric_key: m.metric_key,
      label: m.label,
      unit: m.unit,
      lane: m.lane,
      manual_value: m.manual_value,
      api_value: m.api_value,
      display_origin: m.display_origin,
      entry_id: m.entry_id,
      entered_by_name: m.entered_by_name,
      updated_at: m.updated_at,
      validation_status: m.validation_status,
      approved_at: m.approved_at,
    }));

  const accountHealth = data.byCategory.get("account_health") ?? [];
  const showCompare = compareMode !== "none";

  return (
    <AppShell breadcrumb={["Mthryve OS", "Data Analytics", DEPARTMENT_LABELS[department]]} profile={profile}>
      <PageHeader
        title={`${DEPARTMENT_LABELS[department]} — Data Analytics`}
        subtitle="Provenance-safe metrics. Every value shows its origin; empty metrics read “—”, never 0."
        action={
          <a
            href={exportHref}
            className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-teal-300 hover:bg-charcoal-700"
          >
            Export CSV
          </a>
        }
      />

      {/* Mobile quick-entry / evidence capture — mounted on EVERY department's
          Metrics tab (all five, including Creative) so a number can be snapped and
          filed from anywhere, prefilled to this department. */}
      <div className="mb-6">
        <QuickEntryLauncher defaultDepartment={department} />
      </div>

      <DateRangeControls
        preset={preset}
        compare={compareMode}
        brandId={brandId}
        periodStart={isValidDate(searchParams.period_start) ? searchParams.period_start : range.start}
        periodEnd={isValidDate(searchParams.period_end) ? searchParams.period_end : range.end}
        brands={brands}
        resolvedStart={range.start}
        resolvedEnd={range.end}
      />

      {/* Account Health compliance panel (E-Commerce leads; any dept with the
          category gets one). */}
      {accountHealth.length > 0 && <AccountHealthPanel metrics={accountHealth} />}

      {/* Category card grids (account_health is shown in the panel above). */}
      {CATEGORY_ORDER.filter((c) => c !== "account_health").map((cat) => {
        const list = data.byCategory.get(cat);
        if (!list || list.length === 0) return null;
        return (
          <SectionCard key={cat} title={CATEGORY_LABELS[cat] ?? cat} className="mb-6">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {list.map((m) => (
                <MetricCard key={m.metric_key} metric={m} showCompare={showCompare} />
              ))}
            </div>
          </SectionCard>
        );
      })}

      {/* Any category not in the canonical order (defensive — shouldn't happen). */}
      {Array.from(data.byCategory.keys())
        .filter((c) => !(CATEGORY_ORDER as readonly string[]).includes(c))
        .map((cat) => {
          const list = data.byCategory.get(cat)!;
          return (
            <SectionCard key={cat} title={CATEGORY_LABELS[cat] ?? cat} className="mb-6">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((m) => (
                  <MetricCard key={m.metric_key} metric={m} showCompare={showCompare} />
                ))}
              </div>
            </SectionCard>
          );
        })}

      <EncodePanel
        department={department}
        brandId={brandId}
        periodStart={range.start}
        periodEnd={range.end}
        metrics={encodeMetrics}
        canApprove={canApprove}
      />
    </AppShell>
  );
}
