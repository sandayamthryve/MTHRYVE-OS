import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { WarehouseTabs } from "@/components/warehouse/WarehouseTabs";
import {
  RTS_REASONS,
  RTS_REASON_LABEL,
  RTS_STATUS_LABEL,
  RTS_STATUSES,
  rtsStatusTone,
  nextRtsStatus,
  fmtDate,
  monthKey,
  type RtsStatus,
} from "@/lib/warehouse/rts";
import { saveRtsRecord, updateRtsRecord } from "./actions";
import { createCaseFromRts } from "../cases/actions";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import { QuerySelect } from "@/components/warehouse/QueryControls";

// Warehouse — RTS (Return to Seller). RTS records REUSE public.return_cases: an
// RTS record is a return_cases row with rts_number populated. Shipping fees are
// RECORDED per record and only SUMMED for the analytics tiles — money is never
// moved. Read + write are open to every authenticated role (Warehouse team);
// org scoping is enforced by RLS on return_cases.

export const dynamic = "force-dynamic";

type Brand = { id: string; name: string };
type User = { id: string; full_name: string };
type RtsRow = {
  id: string;
  rts_number: string | null;
  order_number: string | null;
  order_ref: string | null;
  customer_name: string | null;
  brand_id: string | null;
  product_name: string | null;
  sku: string | null;
  units: number | null;
  reason: string | null;
  warehouse_staff_id: string | null;
  courier: string | null;
  shipping_fee: number | null;
  date_received: string | null;
  reported_date: string | null;
  rts_status: string | null;
  archived_at: string | null;
  has_case: boolean;
};

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";
const rowSelectCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink";

export default async function RtsPage({
  searchParams,
}: {
  searchParams: { archived?: string; brand?: string };
}) {
  // Warehouse (Commerce operating surface) — department-scoped to E-Commerce Ops
  // + Warehouse & Fulfillment; leadership bypasses. RLS still scopes rows.
  const profile = await requireModule("/warehouse/rts");
  const supabase = createServerSupabaseClient();
  const now = new Date();
  const today = fmtDate(now);
  const thisMonth = today.slice(0, 7);
  const archived = searchParams?.archived === "1";
  const brandFilter = searchParams?.brand ?? "all";

  const rtsQ = supabase
    .from("return_cases")
    .select(
      "id, rts_number, order_number, order_ref, customer_name, brand_id, product_name, sku, units, reason, warehouse_staff_id, courier, shipping_fee, date_received, reported_date, rts_status, archived_at"
    )
    .not("rts_number", "is", null)
    .order("reported_date", { ascending: false })
    .order("created_at", { ascending: false });
  const [brandRes, userRes, rtsRes, caseRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
    archived ? rtsQ.not("archived_at", "is", null) : rtsQ.is("archived_at", null),
    // Which RTS records already have a case (so the "Open case" button can
    // switch to a "case exists" state — no duplicate encoding).
    supabase.from("cases").select("rts_id").not("rts_id", "is", null),
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const users = (userRes.data ?? []) as unknown as User[];
  const rawRows = (rtsRes.data ?? []) as unknown as Omit<RtsRow, "has_case">[];
  const caseRtsIds = new Set(
    ((caseRes.data ?? []) as unknown as { rts_id: string | null }[])
      .map((r) => r.rts_id)
      .filter(Boolean) as string[]
  );
  const allRows: RtsRow[] = rawRows.map((r) => ({ ...r, has_case: caseRtsIds.has(r.id) }));
  // The brand filter scopes the records AND the headline figures with them. A
  // visible filter that the tiles above it ignore is the classic misreading —
  // you read "Total shipping cost" as the filtered brand's when it is everyone's.
  // The per-brand panel below is the one thing it does NOT scope: that panel IS
  // the brand comparison, so collapsing it to a single row would destroy the
  // only thing it is for. It highlights the selection instead.
  const rows: RtsRow[] =
    brandFilter === "all" ? allRows : allRows.filter((r) => r.brand_id === brandFilter);

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const staffName = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? "—";

  // ── Derived shipping analytics (recorded fees, summed — never moved) ─────────
  const fee = (r: RtsRow) => Number(r.shipping_fee ?? 0);
  const totalShipping = rows.reduce((a, r) => a + fee(r), 0);
  const withFee = rows.filter((r) => r.shipping_fee != null && Number(r.shipping_fee) > 0);
  const avgShipping = withFee.length ? totalShipping / withFee.length : 0;
  const monthlyShipping = rows
    .filter((r) => monthKey(r.reported_date) === thisMonth)
    .reduce((a, r) => a + fee(r), 0);

  // Shipping cost per brand (top by cost).
  const byBrand = new Map<string, { id: string; label: string; count: number; cost: number }>();
  for (const r of allRows) {
    const key = r.brand_id ?? "none";
    const cur = byBrand.get(key) ?? { id: key, label: brandName(r.brand_id), count: 0, cost: 0 };
    cur.count += 1;
    cur.cost += fee(r);
    byBrand.set(key, cur);
  }
  const brandCosts = Array.from(byBrand.values()).sort((a, b) => b.cost - a.cost);
  const maxBrandCost = brandCosts.reduce((m, b) => Math.max(m, b.cost), 0);

  // Monthly shipping expenses trend (last 6 months present in data).
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    const mk = monthKey(r.reported_date);
    if (!mk) continue;
    byMonth.set(mk, (byMonth.get(mk) ?? 0) + fee(r));
  }
  const months = Array.from(byMonth.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 6);
  const maxMonthCost = months.reduce((m, [, c]) => Math.max(m, c), 0);

  const activeCount = rows.filter(
    (r) => r.rts_status !== "completed" && r.rts_status !== "cancelled"
  ).length;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse", "RTS"]} profile={profile}>
      <PageHeader
        title="Return to Seller (RTS)"
        subtitle="Track RTS records through their workflow and see recorded shipping costs. Shipping fees are recorded and summed for reporting — never moved."
      />
      <WarehouseTabs active="rts" />

      {/* Shipping analytics — recorded fees, summed */}
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total shipping cost" value={peso(totalShipping)} hint={`${rows.length} RTS records`} />
        <StatTile label="Avg shipping / RTS" value={peso(avgShipping)} hint={`${withFee.length} with a fee`} />
        <StatTile label="Shipping this month" value={peso(monthlyShipping)} hint={thisMonth} />
        <StatTile label="Active RTS" value={activeCount} hint="not completed / cancelled" />
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <SectionCard title="Shipping cost per brand">
          {brandCosts.length === 0 ? (
            <p className="text-sm text-ink-muted">No RTS records yet.</p>
          ) : (
            <>
              {brandFilter !== "all" && (
                <p className="mb-3 text-[11px] text-ink-muted">
                  Every brand, so the comparison holds — {brandName(brandFilter)} is highlighted.
                  The figures above follow the filter.
                </p>
              )}
              <div className="space-y-3">
                {brandCosts.map((b) => {
                  const pct = maxBrandCost > 0 ? Math.round((b.cost / maxBrandCost) * 100) : 0;
                  const selected = brandFilter !== "all" && b.id === brandFilter;
                  return (
                    <div key={b.label} className={selected ? "" : brandFilter === "all" ? "" : "opacity-45"}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                        <span className={`truncate ${selected ? "font-bold text-ink" : "text-ink-muted"}`}>
                          {b.label}
                        </span>
                        <span className="shrink-0 font-mono text-ink">
                          {b.count} · {peso(b.cost)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
                        <div
                          className={`h-full rounded-full ${selected ? "bg-teal-300" : "bg-teal-500"}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </SectionCard>
        <SectionCard title="Monthly shipping expenses">
          {months.length === 0 ? (
            <p className="text-sm text-ink-muted">No RTS records yet.</p>
          ) : (
            <div className="space-y-3">
              {months.map(([mk, cost]) => {
                const pct = maxMonthCost > 0 ? Math.round((cost / maxMonthCost) * 100) : 0;
                return (
                  <div key={mk}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                      <span className="truncate text-ink-muted">{mk}</span>
                      <span className="shrink-0 font-mono text-ink">{peso(cost)}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
                      <div className="h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Log an RTS record */}
      <SectionCard title="Log an RTS record" className="mb-8">
        <form action={saveRtsRecord} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-[11px] text-ink-muted">
            RTS number
            <input name="rts_number" placeholder="auto (RTS-####)" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Order number
            <input name="order_number" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Customer
            <input name="customer_name" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Brand
            <select name="brand_id" defaultValue="" className={inputCls}>
              <option value="">—</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted lg:col-span-2">
            Product
            <input name="product_name" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            SKU
            <input name="sku" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Quantity
            <input name="units" type="number" min={1} defaultValue={1} className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Reason
            <select name="reason" defaultValue="rts_undelivered" className={inputCls}>
              {RTS_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Warehouse staff
            <select name="warehouse_staff_id" defaultValue="" className={inputCls}>
              <option value="">—</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Courier
            <input name="courier" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Shipping fee (PHP)
            <input name="shipping_fee" type="number" step="0.01" min={0} defaultValue={0} className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Date received
            <input name="date_received" type="date" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Date returned
            <input name="reported_date" type="date" defaultValue={today} className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Status
            <select name="rts_status" defaultValue="pending_verification" className={inputCls}>
              {RTS_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {RTS_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted sm:col-span-2 lg:col-span-3">
            Note
            <input name="note" className={inputCls} />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              className="w-full rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Save RTS
            </button>
          </div>
        </form>
      </SectionCard>

      {/* RTS records */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink">RTS records</h2>
          <ArchivedToggle basePath="/warehouse/rts" archived={archived} />
          <QuerySelect
            name="brand"
            label="Brand"
            value={brandFilter}
            options={[
              { value: "all", label: "All brands" },
              ...brands.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
        </div>
        <span className="text-xs text-ink-muted">{rows.length} records</span>
      </div>
      <TableShell
        columns={[
          "RTS #",
          "Order",
          "Customer",
          "Brand",
          "Product / SKU",
          "Qty",
          "Reason",
          "Staff",
          "Courier",
          "Shipping",
          "Received",
          "Returned",
          "Status / advance",
          "Case",
          "Manage",
        ]}
      >
        {rows.length === 0 && (
          <tr>
            <td colSpan={15} className="p-4 text-ink-muted">
              No RTS records yet — log the first above.
            </td>
          </tr>
        )}
        {rows.map((r) => {
          const fid = `rts-${r.id}`;
          const cur = (r.rts_status ?? "pending_verification") as RtsStatus;
          const nxt = nextRtsStatus(cur);
          return (
            <tr key={r.id} className={rowClass}>
              <td className="p-3 font-mono text-xs text-ink">{r.rts_number ?? "—"}</td>
              <td className="p-3 font-mono text-xs text-ink-muted">{r.order_number ?? r.order_ref ?? "—"}</td>
              <td className="p-3 text-ink-muted">{r.customer_name ?? "—"}</td>
              <td className="p-3 text-ink">{brandName(r.brand_id)}</td>
              <td className="p-3 text-ink">
                {r.product_name?.trim() || "—"}
                {r.sku ? <span className="ml-1 font-mono text-xs text-ink-muted">({r.sku})</span> : null}
              </td>
              <td className="p-3 font-mono text-ink-muted">{Number(r.units ?? 0)}</td>
              <td className="p-3">
                <Badge tone="muted">{RTS_REASON_LABEL.get(r.reason ?? "") ?? r.reason ?? "—"}</Badge>
              </td>
              <td className="p-3 text-ink-muted">{staffName(r.warehouse_staff_id)}</td>
              <td className="p-3 text-ink-muted">{r.courier ?? "—"}</td>
              <td className="p-3 font-mono text-ink">{peso(Number(r.shipping_fee ?? 0))}</td>
              <td className="p-3 font-mono text-xs text-ink-muted">{r.date_received ?? "—"}</td>
              <td className="p-3 font-mono text-xs text-ink-muted">{r.reported_date ?? "—"}</td>
              <td className="p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={rtsStatusTone(cur)}>{RTS_STATUS_LABEL[cur]}</Badge>
                  {cur !== "completed" && cur !== "cancelled" && (
                    <form action={updateRtsRecord} className="flex items-center gap-1">
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="courier" value={r.courier ?? ""} />
                      <input type="hidden" name="warehouse_staff_id" value={r.warehouse_staff_id ?? ""} />
                      <input type="hidden" name="shipping_fee" value={String(r.shipping_fee ?? "")} />
                      <select name="rts_status" defaultValue={nxt ?? cur} className={rowSelectCls}>
                        {nxt && <option value={nxt}>→ {RTS_STATUS_LABEL[nxt]}</option>}
                        <option value="cancelled">Cancel</option>
                      </select>
                      <button
                        type="submit"
                        className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                      >
                        Go
                      </button>
                    </form>
                  )}
                </div>
              </td>
              <td className="p-3">
                {r.has_case ? (
                  <Badge tone="teal">Case open</Badge>
                ) : (
                  <form action={createCaseFromRts} id={fid}>
                    <input type="hidden" name="rts_id" value={r.id} />
                    <button
                      type="submit"
                      className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700"
                    >
                      Open case
                    </button>
                  </form>
                )}
              </td>
              <td className="p-3">
                <RowActions {...rowActionProps("return_cases", r as unknown as Record<string, unknown>, profile)} />
              </td>
            </tr>
          );
        })}
      </TableShell>
    </AppShell>
  );
}
