import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, Badge, rowClass, type BadgeTone } from "@/components/ui";
import { LiveOpsTabs } from "@/components/live-ops/LiveOpsTabs";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// PART E — Campaigns / Promotions / Vouchers / Missions (VIEW ONLY).
//
// Reads op_records filtered to the selected brand (record_type in
// campaign/promotion/mission; voucher/promo config lives in details jsonb).
// Strictly read-only here — these are created and managed in E-Commerce
// (Commerce Ops → Operational Records). There is NO write path on this surface.

export const dynamic = "force-dynamic";

type Brand = { id: string; name: string };
interface OpRecord {
  id: string;
  record_type: string;
  brand_id: string | null;
  title: string;
  details: Record<string, unknown> | null;
  status: string;
  assigned_team: string | null;
  start_date: string | null;
  end_date: string | null;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "muted",
  submitted: "violet",
  approved: "teal",
  rejected: "red",
  revision_requested: "amber",
  completed: "teal",
};

interface SearchParams { brand?: string; type?: string }

export default async function LiveCampaignsPage({ searchParams }: { searchParams?: SearchParams }) {
  const profile = await requireModule("/live-ops");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const [recordsRes, brandsRes] = await Promise.all([
    u.from("op_records").select("*").order("start_date", { ascending: false, nullsFirst: false }),
    supabase.from("brands").select("id, name").order("name"),
  ]);
  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const all = (recordsRes.data ?? []) as OpRecord[];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";

  const brandFilter = searchParams?.brand ?? "";
  const typeFilter = searchParams?.type ?? "";
  // Live Ops cares about campaigns, promotions and missions (rewards live in
  // E-Commerce). Vouchers/promo config are surfaced from details jsonb.
  const relevant = all.filter((r) => ["campaign", "promotion", "mission"].includes(r.record_type));
  const rows = relevant.filter(
    (r) => (!brandFilter || r.brand_id === brandFilter) && (!typeFilter || r.record_type === typeFilter)
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Operations", "Campaigns"]} profile={profile}>
      <PageHeader
        title="Campaigns & Promotions"
        subtitle="Read-only view of the campaigns, promotions, vouchers and missions in play for a brand. Managed in E-Commerce — there is no edit path here."
        action={<Badge tone="muted">View only</Badge>}
      />
      <LiveOpsTabs />

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Brand
          <select name="brand" defaultValue={brandFilter} className="mt-1 block rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink">
            <option value="">All brands</option>
            {brands.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
          </select>
        </label>
        <label className="text-[10px] uppercase tracking-wider text-ink-muted">
          Type
          <select name="type" defaultValue={typeFilter} className="mt-1 block rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink">
            <option value="">All types</option>
            <option value="campaign">Campaign</option>
            <option value="promotion">Promotion</option>
            <option value="mission">Mission</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-teal-500 px-3 py-2 text-xs font-semibold text-charcoal-950 hover:bg-teal-400">Apply</button>
        <Link href="/live-ops/campaigns" className="rounded-md bg-charcoal-800 px-3 py-2 text-xs text-ink-muted hover:bg-charcoal-700">Reset</Link>
      </form>

      <SectionCard title="Active & scheduled records">
        <TableShell columns={["Title", "Type", "Brand", "Window", "Voucher / config", "Status"]}>
          {rows.length === 0 && (
            <tr><td colSpan={6} className="p-4 text-ink-muted">No campaigns, promotions or missions for this filter. These are created in E-Commerce → Operational Records.</td></tr>
          )}
          {rows.map((r) => {
            const details = r.details ?? {};
            const voucher =
              (details.voucher_code as string) ||
              (details.code as string) ||
              (details.discount as string) ||
              (typeof details.value !== "undefined" ? String(details.value) : "") ||
              "";
            return (
              <tr key={r.id} className={rowClass}>
                <td className="p-3 text-ink">{r.title}</td>
                <td className="p-3"><Badge tone="violet">{r.record_type}</Badge></td>
                <td className="p-3 text-ink-muted">{brandName(r.brand_id)}</td>
                <td className="p-3 font-mono text-[11px] text-ink-muted">
                  {r.start_date ?? "—"}{r.end_date ? ` → ${r.end_date}` : ""}
                </td>
                <td className="p-3 font-mono text-[11px] text-ink-muted">{voucher || "—"}</td>
                <td className="p-3"><Badge tone={STATUS_TONE[r.status] ?? "muted"}>{r.status}</Badge></td>
              </tr>
            );
          })}
        </TableShell>
        <p className="mt-3 text-[10px] text-ink-dim">
          Source: op_records (Commerce Ops). This tab never writes — to change a campaign, promotion, voucher or mission, use{" "}
          <Link href="/commerce-ops" className="text-teal-300 hover:text-teal-200">Operational Records</Link>.
        </p>
      </SectionCard>
    </AppShell>
  );
}
