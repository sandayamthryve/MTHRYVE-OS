import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso } from "@/lib/metrics/format";
import { WarehouseTabs } from "@/components/warehouse/WarehouseTabs";
import {
  CASE_PRIORITY_LABEL,
  CASE_SETTLED,
  CASE_STATUS_LABEL,
  RTS_REASON_LABEL,
  caseStatusTone,
  priorityTone,
  fmtDate,
  daysSince,
  type CaseStatus,
  type CasePriority,
} from "@/lib/warehouse/rts";
import { createCaseManual } from "./actions";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Warehouse — Case Monitoring dashboard. All analytics here are DERIVED from the
// real public.cases rows (and the recorded shipping_fee on the linked RTS record)
// — nothing is re-encoded. Honest nulls: a figure with no data reads "—", never a
// fabricated zero. Read/write open to every authenticated role; RLS scopes by org
// and the DB guard keeps Resolved/Closed leadership-only.

export const dynamic = "force-dynamic";

type Brand = { id: string; name: string };
type User = { id: string; full_name: string };
type CaseRow = {
  id: string;
  case_number: string | null;
  rts_id: string | null;
  brand_id: string | null;
  product: string | null;
  customer: string | null;
  reason: string | null;
  assigned_to: string | null;
  priority: string | null;
  due_date: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

const DUE_SOON_DAYS = 2;

export default async function CaseMonitoringPage({
  searchParams,
}: {
  searchParams: { archived?: string };
}) {
  // Warehouse (Commerce operating surface) — department-scoped to E-Commerce Ops
  // + Warehouse & Fulfillment; leadership bypasses. RLS still scopes rows.
  const profile = await requireModule("/warehouse/cases");
  const supabase = createServerSupabaseClient();
  const now = new Date();
  const today = fmtDate(now);
  const archived = searchParams?.archived === "1";

  const caseQ = supabase
    .from("cases")
    .select(
      "id, case_number, rts_id, brand_id, product, customer, reason, assigned_to, priority, due_date, status, created_at, updated_at, archived_at"
    )
    .order("created_at", { ascending: false });
  const [brandRes, userRes, caseRes, rtsRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
    archived ? caseQ.not("archived_at", "is", null) : caseQ.is("archived_at", null),
    // Recorded shipping fees on the linked RTS records — for Shipping Fee Impact.
    supabase.from("return_cases").select("id, shipping_fee").not("rts_number", "is", null),
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const users = (userRes.data ?? []) as unknown as User[];
  const cases = (caseRes.data ?? []) as unknown as CaseRow[];
  const feeByRts = new Map(
    ((rtsRes.data ?? []) as unknown as { id: string; shipping_fee: number | null }[]).map((r) => [
      r.id,
      Number(r.shipping_fee ?? 0),
    ])
  );

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const userName = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? "Unassigned";
  const caseFee = (c: CaseRow) => (c.rts_id ? feeByRts.get(c.rts_id) ?? 0 : 0);

  // ── Derived analytics ────────────────────────────────────────────────────────
  const total = cases.length;
  const open = cases.filter((c) => !CASE_SETTLED.has((c.status ?? "new") as CaseStatus)).length;
  const closed = total - open;
  const overdue = cases.filter(
    (c) =>
      c.due_date &&
      c.due_date < today &&
      !CASE_SETTLED.has((c.status ?? "new") as CaseStatus)
  );
  // Days from today until a YYYY-MM-DD due date (>= 0 when in the future).
  const daysUntil = (due: string) => daysSince(today, new Date(`${due}T00:00:00`));
  const dueSoon = cases.filter((c) => {
    if (!c.due_date || CASE_SETTLED.has((c.status ?? "new") as CaseStatus)) return false;
    if (c.due_date < today) return false; // overdue is handled separately
    return daysUntil(c.due_date) <= DUE_SOON_DAYS;
  });

  // Avg resolution time — created_at → updated_at for settled cases (honest: null
  // when there are no settled cases yet).
  const settled = cases.filter((c) => CASE_SETTLED.has((c.status ?? "new") as CaseStatus));
  const avgResolveDays =
    settled.length > 0
      ? settled.reduce((a, c) => {
          const ms = new Date(c.updated_at).getTime() - new Date(c.created_at).getTime();
          return a + Math.max(0, ms / 86_400_000);
        }, 0) / settled.length
      : null;

  const totalShippingImpact = cases.reduce((a, c) => a + caseFee(c), 0);

  // Rollup helper.
  function rollup<T extends string>(
    keyOf: (c: CaseRow) => T | null,
    labelOf: (k: T) => string
  ): { key: string; label: string; count: number }[] {
    const m = new Map<string, { key: string; label: string; count: number }>();
    for (const c of cases) {
      const k = keyOf(c);
      if (k == null) continue;
      const cur = m.get(k) ?? { key: k, label: labelOf(k), count: 0 };
      cur.count += 1;
      m.set(k, cur);
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count);
  }

  const byBrand = rollup((c) => c.brand_id, (k) => brandName(k)).slice(0, 8);
  const byPriority = rollup(
    (c) => (c.priority ?? "medium") as CasePriority,
    (k) => CASE_PRIORITY_LABEL[k] ?? k
  );
  const byAssignee = rollup((c) => c.assigned_to ?? "unassigned", (k) =>
    k === "unassigned" ? "Unassigned" : userName(k)
  ).slice(0, 8);
  const byReason = rollup(
    (c) => c.reason,
    (k) => RTS_REASON_LABEL.get(k) ?? k
  ).slice(0, 8);

  // Shipping fee impact per case (top by recorded fee).
  const feeImpact = cases
    .map((c) => ({ c, fee: caseFee(c) }))
    .filter((x) => x.fee > 0)
    .sort((a, b) => b.fee - a.fee)
    .slice(0, 8);

  const inputCls =
    "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";

  const RollupPanel = ({
    title,
    rows,
    money,
  }: {
    title: string;
    rows: { key: string; label: string; count: number }[];
    money?: boolean;
  }) => {
    const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
    return (
      <SectionCard title={title}>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-muted">No cases yet.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const pct = max > 0 ? Math.round((r.count / max) * 100) : 0;
              return (
                <div key={r.key}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-ink-muted">{r.label}</span>
                    <span className="shrink-0 font-mono text-ink">{r.count}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
                    <div className="h-full rounded-full bg-teal-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    );
  };

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse", "Case Monitoring"]} profile={profile}>
      <PageHeader
        title="Case Monitoring"
        subtitle="Track investigation cases from New to Closed. Analytics derive from real cases; open a case from an RTS record in one click."
      />
      <WarehouseTabs active="cases" />

      {/* Headline analytics */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total cases" value={total} hint={`${open} open · ${closed} closed`} />
        <StatTile
          label="Overdue"
          value={overdue.length}
          valueClassName={overdue.length > 0 ? "text-red-300" : "text-ink"}
          hint={`${dueSoon.length} due within ${DUE_SOON_DAYS}d`}
        />
        <StatTile
          label="Avg resolution"
          value={avgResolveDays == null ? "—" : `${avgResolveDays.toFixed(1)}d`}
          hint={settled.length ? `${settled.length} settled` : "no settled cases"}
        />
        <StatTile
          label="Shipping fee impact"
          value={peso(totalShippingImpact)}
          hint="recorded RTS fees on cases"
        />
      </div>

      {/* Overdue / due-soon watch — surfaced on the dashboard */}
      {(overdue.length > 0 || dueSoon.length > 0) && (
        <SectionCard title="Due-date watch" className="mb-8">
          <div className="space-y-2">
            {overdue.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3"
              >
                <Link href={`/warehouse/cases/${c.id}`} className="min-w-0 text-sm text-ink hover:text-teal-300">
                  <span className="font-mono text-xs text-ink-muted">{c.case_number}</span> ·{" "}
                  {c.product ?? "—"}
                </Link>
                <div className="flex items-center gap-2 text-xs">
                  <Badge tone="red">Overdue · {c.due_date}</Badge>
                  <span className="text-ink-muted">{userName(c.assigned_to)}</span>
                </div>
              </div>
            ))}
            {dueSoon.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
              >
                <Link href={`/warehouse/cases/${c.id}`} className="min-w-0 text-sm text-ink hover:text-teal-300">
                  <span className="font-mono text-xs text-ink-muted">{c.case_number}</span> ·{" "}
                  {c.product ?? "—"}
                </Link>
                <div className="flex items-center gap-2 text-xs">
                  <Badge tone="amber">Due {c.due_date}</Badge>
                  <span className="text-ink-muted">{userName(c.assigned_to)}</span>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Drill-down rollups */}
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <RollupPanel title="Cases by brand (top 8)" rows={byBrand} />
        <RollupPanel title="Cases by priority" rows={byPriority} />
        <RollupPanel title="Cases by assigned personnel (top 8)" rows={byAssignee} />
        <RollupPanel title="Most common RTS reasons" rows={byReason} />
      </div>

      {/* Shipping fee impact per case */}
      <SectionCard title="Shipping fee impact per case (top 8)" className="mb-8">
        {feeImpact.length === 0 ? (
          <p className="text-sm text-ink-muted">No cases with a recorded shipping fee yet.</p>
        ) : (
          <div className="space-y-2">
            {feeImpact.map(({ c, fee }) => (
              <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <Link href={`/warehouse/cases/${c.id}`} className="truncate text-ink hover:text-teal-300">
                  <span className="font-mono text-xs text-ink-muted">{c.case_number}</span> ·{" "}
                  {c.product ?? "—"}
                </Link>
                <span className="shrink-0 font-mono text-ink">{peso(fee)}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Manual case (a case not sourced from an RTS record) */}
      <SectionCard title="Open a case manually" className="mb-8">
        <p className="mb-3 text-xs text-ink-muted">
          Most cases open straight from an RTS record (RTS tab → Open case). Use this only for a case
          with no RTS record behind it.
        </p>
        <form action={createCaseManual} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-[11px] text-ink-muted lg:col-span-2">
            Product
            <input name="product" required className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            SKU
            <input name="sku" className={inputCls} />
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
          <label className="text-[11px] text-ink-muted">
            Customer
            <input name="customer" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted lg:col-span-2">
            Reason
            <input name="reason" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Priority
            <select name="priority" defaultValue="medium" className={inputCls}>
              {(Object.keys(CASE_PRIORITY_LABEL) as CasePriority[]).map((p) => (
                <option key={p} value={p}>
                  {CASE_PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted sm:col-span-2 lg:col-span-3">
            Shipping details
            <input name="shipping_details" className={inputCls} />
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              className="w-full rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Open case
            </button>
          </div>
        </form>
      </SectionCard>

      {/* Case list */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-ink">All cases</h2>
          <ArchivedToggle basePath="/warehouse/cases" archived={archived} />
        </div>
        <span className="text-xs text-ink-muted">{total} cases</span>
      </div>
      <TableShell
        columns={["Case #", "Product", "Brand", "Customer", "Reason", "Assigned", "Priority", "Due", "Status", "Manage"]}
      >
        {cases.length === 0 && (
          <tr>
            <td colSpan={10} className="p-4 text-ink-muted">
              No cases yet — open one from an RTS record or manually above.
            </td>
          </tr>
        )}
        {cases.map((c) => {
          const st = (c.status ?? "new") as CaseStatus;
          const isOverdue =
            c.due_date && c.due_date < today && !CASE_SETTLED.has(st);
          return (
            <tr key={c.id} className={rowClass}>
              <td className="p-3">
                <Link href={`/warehouse/cases/${c.id}`} className="font-mono text-xs text-teal-300 hover:text-teal-200">
                  {c.case_number ?? c.id.slice(0, 8)}
                </Link>
              </td>
              <td className="p-3 text-ink">{c.product ?? "—"}</td>
              <td className="p-3 text-ink-muted">{brandName(c.brand_id)}</td>
              <td className="p-3 text-ink-muted">{c.customer ?? "—"}</td>
              <td className="p-3 text-ink-muted">{RTS_REASON_LABEL.get(c.reason ?? "") ?? c.reason ?? "—"}</td>
              <td className="p-3 text-ink-muted">{userName(c.assigned_to)}</td>
              <td className="p-3">
                <Badge tone={priorityTone(c.priority)}>
                  {CASE_PRIORITY_LABEL[(c.priority ?? "medium") as CasePriority] ?? c.priority}
                </Badge>
              </td>
              <td className="p-3 font-mono text-xs">
                <span className={isOverdue ? "text-red-300" : "text-ink-muted"}>{c.due_date ?? "—"}</span>
              </td>
              <td className="p-3">
                <Badge tone={caseStatusTone(st)}>{CASE_STATUS_LABEL[st]}</Badge>
              </td>
              <td className="p-3">
                <RowActions {...rowActionProps("cases", c as unknown as Record<string, unknown>, profile)} />
              </td>
            </tr>
          );
        })}
      </TableShell>
    </AppShell>
  );
}
