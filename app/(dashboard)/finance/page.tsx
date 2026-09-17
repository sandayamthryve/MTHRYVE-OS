import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass, HelpHint } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { customWindow } from "@/lib/metrics/windows";
import { fetchCommerceRows, aggregate } from "@/lib/metrics/gmv";
import { loadCashflow } from "@/lib/finance/data";
import { parseHorizon, ALLOWED_HORIZONS } from "@/lib/finance/forecast";
import { CashflowForecast } from "@/components/finance/CashflowForecast";
import { ScanCashflowButton } from "@/components/finance/ScanCashflowButton";
import { AiBrief } from "@/components/briefings/AiBrief";
import { StalenessBanner } from "@/components/briefings/StalenessBanner";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";

// Finance / P&L — module entry follows the PDF Finance grant. Server actions
// retain their separate leadership requirements.
// Revenue is computed per brand by its revenue model (operator vs agency);
// costs (opex/capex) are entered by leadership in the expense ledger.

type Brand = { id: string; name: string };
type Model = "operator" | "agency";
type BrandFinance = {
  brand_id: string;
  model: Model | null;
  cogs_pct: number | null;
  take_pct: number | null;
  retainer_monthly: number | null;
};
type FinanceEntry = {
  id: string;
  entry_date: string | null;
  type: "opex" | "capex";
  category: string | null;
  amount: number | null;
  brand_id: string | null;
  note: string | null;
  archived_at: string | null;
};

// These four tables aren't in the generated Supabase types, so writes go through
// this shim to keep insert/update/upsert/delete callable without `any`.
type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<unknown>;
    upsert: (
      v: Record<string, unknown>,
      opts?: Record<string, unknown>
    ) => Promise<unknown>;
    delete: () => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

// Format a Date as YYYY-MM-DD from its local parts (avoids the UTC drift a
// toISOString() slice would introduce for a midnight-local date).
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function num(v: FormDataEntryValue | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// --- Server actions (all ceo/coo only) ------------------------------------

async function saveBrandFinance(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as {
    id: string;
    org_id: string;
  };
  const brand_id = String(formData.get("brand_id") ?? "");
  if (!brand_id) return;
  const model = String(formData.get("model") ?? "operator") === "agency" ? "agency" : "operator";

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("brand_finance").upsert(
    {
      brand_id,
      org_id: profile.org_id,
      model,
      cogs_pct: num(formData.get("cogs_pct")),
      take_pct: num(formData.get("take_pct")),
      retainer_monthly: num(formData.get("retainer_monthly")),
    },
    { onConflict: "brand_id" }
  );
  revalidatePath("/finance");
}

async function addFinanceEntry(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as {
    id: string;
    org_id: string;
  };
  const entry_date = String(formData.get("entry_date") ?? "");
  const category = String(formData.get("category") ?? "").trim();
  const amount = num(formData.get("amount"));
  if (!entry_date || !category || !amount) return;
  const type = String(formData.get("type") ?? "opex") === "capex" ? "capex" : "opex";
  const brand_id = String(formData.get("brand_id") ?? "") || null;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("finance_entries").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    entry_date,
    type,
    category,
    amount,
    brand_id,
    note: String(formData.get("note") ?? "") || null,
  });
  revalidatePath("/finance");
}

// NOTE: the bespoke one-click finance-entry delete (deleteFinanceEntry) was
// removed in the delete-sweep — a finance entry is a ledger record, so its only
// permanent-delete path is now the governed 2-approval gate (entity
// 'finance_entry', COO → CEO, audited), surfaced by the RowActions "Request
// deletion" control in the Manage column. Archive (soft) stays one-click there.

// Set / update the current cash on hand. Every save inserts a NEW dated row —
// the latest by as_of_date is the forecast anchor, and prior rows are kept as
// history. Amount 0 is a legitimate position (empty account); only a missing
// date or a blank amount field is rejected. ceo/coo only (RLS re-checks).
async function saveCashPosition(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo"])) as unknown as {
    id: string;
    org_id: string;
  };
  const as_of_date = String(formData.get("as_of_date") ?? "");
  const amountRaw = formData.get("amount");
  if (!as_of_date || amountRaw == null || String(amountRaw).trim() === "") return;
  const amount = num(amountRaw);
  const account = String(formData.get("account") ?? "").trim() || "primary";
  const note = String(formData.get("note") ?? "").trim() || null;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("cash_positions").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    as_of_date,
    amount,
    account,
    note,
  });
  revalidatePath("/finance");
}

// --- Page ------------------------------------------------------------------

export default async function FinancePage({
  searchParams,
}: {
  searchParams: DateRangeSearchParams & { h?: string; archived?: string };
}) {
  const profile = await requireModule("/finance");
  const supabase = createServerSupabaseClient();
  const archived = searchParams.archived === "1";

  // Cash-flow forecast (default 60d horizon; 30/90 selectable). Runs through the
  // SHARED engine the "Scan cash flow" producer uses, so the projection shown
  // here is exactly what Tony routes on. Honest empty state until a position is set.
  const horizon = parseHorizon(searchParams.h);
  const cashflow = await loadCashflow(
    supabase as unknown as { from: (t: string) => any },
    profile.org_id,
    { horizonDays: horizon, actorRole: profile.role, actorId: profile.id }
  );

  // Shared date-range control — same Today/…/Custom picker as every other
  // dashboard, defaulting to MTD to match the Expenses sibling. resolveDateRange
  // still accepts the legacy ?from/?to this page used to write, so old bookmarks
  // keep resolving.
  const dr = resolveDateRange(searchParams, { fallbackPreset: "mtd" });
  const from = dr.range.start;
  const to = dr.range.end;
  // "Today" for the cash-position / expense-entry form defaults below.
  const now = new Date();
  const nowMs = now.getTime();
  const today = fmtDate(now);
  // Preserve the active window on the in-page links that carry other params
  // (forecast horizon, archived toggle). Presets travel as ?preset; only a custom
  // range needs explicit dates.
  const dateParams: Record<string, string> =
    dr.preset === "custom"
      ? { preset: "custom", period_start: from, period_end: to }
      : { preset: dr.preset };

  // The ledger list flips between active and archived entries; archived rows are
  // excluded from the forecast (see lib/finance/data.ts) so they never move the P&L.
  const entryBase = supabase
    .from("finance_entries")
    .select("id, entry_date, type, category, amount, brand_id, note, archived_at")
    .gte("entry_date", from)
    .lte("entry_date", to);
  const entryFiltered = archived
    ? entryBase.not("archived_at", "is", null)
    : entryBase.is("archived_at", null);

  const [brandRes, finRes, bpmRows, entryRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("brand_finance").select("brand_id, model, cogs_pct, take_pct, retainer_monthly"),
    fetchCommerceRows(supabase),
    entryFiltered.order("entry_date", { ascending: false }),
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const finances = (finRes.data ?? []) as unknown as BrandFinance[];
  const entries = (entryRes.data ?? []) as unknown as FinanceEntry[];

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const financeByBrand = new Map<string, BrandFinance>();
  for (const f of finances) financeByBrand.set(f.brand_id, f);

  // GMV in the selected [from, to] range, per brand — through the shared metrics
  // layer so it collapses overlapping/duplicate periods (no double-count) and
  // reconciles with every other GMV surface for the same range.
  const rangeWindow = customWindow(from, to, `${from} → ${to}`);
  const gmvByBrand = new Map<string, number>();
  for (const b of brands) {
    gmvByBrand.set(b.id, aggregate(bpmRows, rangeWindow, { brandId: b.id }).gmv);
  }

  // Per-brand P&L — revenue and COGS depend on the revenue model.
  const perBrand = brands
    .map((b) => {
      const gmv = gmvByBrand.get(b.id) ?? 0;
      const f = financeByBrand.get(b.id);
      const model: Model = f?.model === "agency" ? "agency" : "operator";
      let revenue = 0;
      let cogs = 0;
      if (model === "agency") {
        revenue = (Number(f?.take_pct ?? 0) / 100) * gmv + Number(f?.retainer_monthly ?? 0);
        cogs = 0;
      } else {
        revenue = gmv;
        cogs = (Number(f?.cogs_pct ?? 0) / 100) * gmv;
      }
      return { brand: b, model, gmv, revenue, cogs, gross: revenue - cogs };
    })
    // Show brands with any activity or configuration first; drop fully-empty rows.
    .filter((r) => r.gmv !== 0 || r.revenue !== 0 || financeByBrand.has(r.brand.id));

  const revenue = perBrand.reduce((a, r) => a + r.revenue, 0);
  const cogs = perBrand.reduce((a, r) => a + r.cogs, 0);
  const grossProfit = revenue - cogs;

  const opexEntries = entries.filter((e) => e.type === "opex");
  const capexEntries = entries.filter((e) => e.type === "capex");
  const opex = opexEntries.reduce((a, e) => a + Number(e.amount ?? 0), 0);
  const capex = capexEntries.reduce((a, e) => a + Number(e.amount ?? 0), 0);
  const operatingProfit = grossProfit - opex;

  // Opex grouped by category.
  const opexByCategory = new Map<string, number>();
  for (const e of opexEntries) {
    const key = (e.category ?? "Uncategorized").trim() || "Uncategorized";
    opexByCategory.set(key, (opexByCategory.get(key) ?? 0) + Number(e.amount ?? 0));
  }
  const opexCats = Array.from(opexByCategory.entries()).sort((a, b) => b[1] - a[1]);
  const opexMax = opexCats.reduce((m, [, v]) => Math.max(m, v), 0);

  const profitClass = operatingProfit >= 0 ? "text-teal-300" : "text-red-300";

  // Waterfall rows: label, value, and how to render the sign.
  const waterfall: { label: string; value: number; op: "=" | "-" | "+"; strong?: boolean }[] = [
    { label: "Revenue", value: revenue, op: "+" },
    { label: "COGS", value: cogs, op: "-" },
    { label: "Gross Profit", value: grossProfit, op: "=", strong: true },
    { label: "Opex", value: opex, op: "-" },
    { label: "Operating Profit", value: operatingProfit, op: "=", strong: true },
  ];

  return (
    <AppShell breadcrumb={["Mthryve OS", "Finance"]} profile={profile}>
      <PageHeader
        title={<>Finance / P&amp;L <HelpHint id="money.finance" /></>}
        subtitle={`Leadership view. Revenue is computed per brand by model; costs are entered below. · ${dr.rangeLabel}`}
      />

      {/* Shared date-range control — replaces the bare From/To picker so Finance
          matches every other dashboard. Brand + Compare levers aren't wired here
          (the P&L already breaks out per brand), so the picker hides them. */}
      <DateRangeControls {...dr.controlProps} brands={[]} showBrand={false} showCompare={false} />

      {/* 0. Finance AI brief — CEO/COO only. The whole page is already gated to
          ceo/coo (requireRole above) and finance_briefings RLS is ceo/coo-only,
          but guard the render explicitly so it never appears for another role. */}
      {(profile.role === "ceo" || profile.role === "coo") && (
        <div className="mb-8">
          <AiBrief scope="finance" />
        </div>
      )}

      {/* 1. Cash-flow forecast — runway, projected-balance line, drivers, and the
          cash-position input. Honest empty state until a position is set. */}
      <SectionCard title="Cash-flow forecast" className="mb-8">
        {/* Staleness — the SAME amber banner the briefing surfaces use, reused
            verbatim. A cash position is expected to hold for a week, so the
            threshold is 7 days (vs the briefing default of 24h); it dates from
            as_of_date and renders only once the anchor crosses that age. */}
        {cashflow.anchor && (
          <StalenessBanner
            createdAt={cashflow.anchor.as_of_date}
            nowMs={nowMs}
            noun="cash position"
            verb="As of"
            staleAfterHours={7 * 24}
          />
        )}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            {ALLOWED_HORIZONS.map((hz) => {
              const params = new URLSearchParams(dateParams);
              params.set("h", String(hz));
              const active = hz === horizon;
              return (
                <a
                  key={hz}
                  href={`/finance?${params.toString()}`}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
                    active
                      ? "bg-teal-500 text-charcoal-950"
                      : "bg-charcoal-800 text-ink-muted hover:bg-charcoal-700 hover:text-ink"
                  }`}
                >
                  {hz}d
                </a>
              );
            })}
          </div>
          {cashflow.anchor && <ScanCashflowButton />}
        </div>

        {cashflow.anchor && cashflow.forecast ? (
          <CashflowForecast forecast={cashflow.forecast} />
        ) : (
          <div className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-4 text-sm text-ink-muted">
            No cash position recorded. Set the current cash on hand below to project runway and
            enable deficit scanning — the OS never assumes a balance it wasn&apos;t given.
          </div>
        )}

        {/* Set cash position — the forecast anchor and the ONE action a leader
            needs on this screen, so it's given its own highlighted panel instead
            of sitting as a bare row under the empty state. The two required
            fields (amount + the date it applies to) lead; account/note are
            optional. Inputs use text-base on mobile (no iOS zoom-on-focus) and a
            numeric keypad, and the grid collapses to one column on phones. */}
        <div className="mt-6 rounded-xl border border-teal-500/30 bg-teal-500/[0.04] p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-ink">
            {cashflow.anchor ? "Update cash position" : "Set cash position"}
          </h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            The balance the whole forecast is anchored on. Saving records a new dated position; the
            latest date is always the anchor.
          </p>
          <form action={saveCashPosition} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-[11px] font-medium text-ink-muted">
              Cash on hand (PHP) <span className="text-teal-400">*</span>
              <input
                name="amount"
                type="number"
                inputMode="numeric"
                step="1"
                required
                defaultValue={cashflow.anchor ? Math.round(Number(cashflow.anchor.amount)) : ""}
                placeholder="0"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-base text-ink sm:text-sm"
              />
            </label>
            <label className="text-[11px] font-medium text-ink-muted">
              Date it applies to <span className="text-teal-400">*</span>
              <input
                name="as_of_date"
                type="date"
                required
                defaultValue={today}
                max={today}
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-base text-ink sm:text-sm"
              />
            </label>
            <label className="text-[11px] text-ink-muted">
              Account (optional)
              <input
                name="account"
                defaultValue={cashflow.anchor?.account ?? "primary"}
                placeholder="primary"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-base text-ink sm:text-sm"
              />
            </label>
            <label className="text-[11px] text-ink-muted">
              Note (optional)
              <input
                name="note"
                placeholder="Memo"
                className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-base text-ink sm:text-sm"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2.5 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-2 sm:w-auto sm:justify-self-start lg:col-span-4"
            >
              {cashflow.anchor ? "Update cash position" : "Set cash position"}
            </button>
          </form>
          {cashflow.anchor && (
            <p className="mt-3 text-xs text-ink-muted">
              Current anchor:{" "}
              <span className="font-mono text-ink">
                {peso(Math.round(Number(cashflow.anchor.amount)))}
              </span>{" "}
              as of {cashflow.anchor.as_of_date}
              {cashflow.anchor.account ? ` · ${cashflow.anchor.account}` : ""}.
            </p>
          )}
        </div>
      </SectionCard>

      {/* 2. P&L summary — stat tiles + waterfall. */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Revenue" value={peso(revenue)} />
        <StatTile label="Gross Profit" value={peso(grossProfit)} hint={`COGS ${peso(cogs)}`} />
        <StatTile
          label="Operating Profit"
          value={peso(operatingProfit)}
          valueClassName={profitClass}
          hint={`after ${peso(opex)} opex`}
        />
        <StatTile label="Capex (separate)" value={peso(capex)} hint="not subtracted from operating profit" />
      </div>

      <SectionCard title="P&L waterfall" className="mb-8">
        <div className="space-y-1.5">
          {waterfall.map((w) => (
            <div
              key={w.label}
              className={`flex items-center justify-between border-b border-charcoal-700/60 py-2 last:border-0 ${
                w.strong ? "font-semibold text-ink" : "text-ink-muted"
              }`}
            >
              <span className="flex items-center gap-2 text-sm">
                <span className="w-4 font-mono text-ink-dim">{w.op}</span>
                {w.label}
              </span>
              <span
                className={`font-mono text-sm ${
                  w.label === "Operating Profit" ? profitClass : w.strong ? "text-ink" : "text-ink-muted"
                }`}
              >
                {peso(w.value)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 text-ink-muted">
            <span className="flex items-center gap-2 text-sm">
              <span className="w-4 font-mono text-ink-dim">±</span>
              Capex (shown separately)
            </span>
            <span className="font-mono text-sm text-ink-muted">{peso(capex)}</span>
          </div>
        </div>
      </SectionCard>

      {/* 3. Opex by category. */}
      <SectionCard title="Opex by category" className="mb-8">
        {opexCats.length === 0 ? (
          <p className="text-sm text-ink-muted">No opex recorded in this period.</p>
        ) : (
          <div className="space-y-3">
            {opexCats.map(([cat, total]) => {
              const pct = opexMax > 0 ? Math.round((total / opexMax) * 100) : 0;
              return (
                <div key={cat}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-ink-muted">{cat}</span>
                    <span className="font-mono text-ink">{peso(total)}</span>
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

      {/* 4. Per-brand P&L. */}
      <h2 className="mb-3 text-sm font-semibold text-ink">Per-brand P&amp;L</h2>
      <TableShell
        className="mb-8"
        columns={["Brand", "Model", "GMV in range", "Revenue", "COGS", "Gross profit"]}
      >
        {perBrand.length === 0 && (
          <tr>
            <td colSpan={6} className="p-4 text-ink-muted">
              No brand activity or revenue models configured for this period.
            </td>
          </tr>
        )}
        {perBrand.map((r) => (
          <tr key={r.brand.id} className={rowClass}>
            <td className="p-3 text-ink">{r.brand.name}</td>
            <td className="p-3">
              <Badge tone={r.model === "agency" ? "violet" : "teal"}>{r.model}</Badge>
            </td>
            <td className="p-3 font-mono text-ink-muted">{peso(r.gmv)}</td>
            <td className="p-3 font-mono text-ink">{peso(r.revenue)}</td>
            <td className="p-3 font-mono text-ink-muted">{peso(r.cogs)}</td>
            <td className="p-3 font-mono text-ink">{peso(r.gross)}</td>
          </tr>
        ))}
      </TableShell>

      {/* 5. Brand revenue model config. */}
      <SectionCard title="Brand revenue models" className="mb-8">
        <p className="mb-4 text-xs text-ink-muted">
          Operator brands earn GMV as revenue less COGS. Agency brands earn a take of GMV plus a{" "}
          <span className="text-ink">flat retainer (not prorated)</span>.
        </p>
        <div className="space-y-3">
          {brands.length === 0 && <p className="text-sm text-ink-muted">No brands yet.</p>}
          {brands.map((b) => {
            const f = financeByBrand.get(b.id);
            const model: Model = f?.model === "agency" ? "agency" : "operator";
            return (
              <form
                key={b.id}
                action={saveBrandFinance}
                className="grid items-end gap-2 rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3 sm:grid-cols-[1.4fr_1fr_1fr_1fr_auto]"
              >
                <input type="hidden" name="brand_id" value={b.id} />
                <div className="text-sm text-ink">{b.name}</div>
                <label className="text-[11px] text-ink-muted">
                  Model
                  <select
                    name="model"
                    defaultValue={model}
                    className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
                  >
                    <option value="operator">operator</option>
                    <option value="agency">agency</option>
                  </select>
                </label>
                <label className="text-[11px] text-ink-muted">
                  COGS % (operator)
                  <input
                    name="cogs_pct"
                    type="number"
                    step="0.1"
                    defaultValue={f?.cogs_pct ?? 0}
                    className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
                  />
                </label>
                <label className="text-[11px] text-ink-muted">
                  Take % (agency)
                  <input
                    name="take_pct"
                    type="number"
                    step="0.1"
                    defaultValue={f?.take_pct ?? 0}
                    className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
                  />
                </label>
                <label className="text-[11px] text-ink-muted">
                  Retainer / mo (agency)
                  <input
                    name="retainer_monthly"
                    type="number"
                    defaultValue={f?.retainer_monthly ?? 0}
                    className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
                  />
                </label>
                <button
                  type="submit"
                  className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:col-span-5 sm:w-auto sm:justify-self-start"
                >
                  Save
                </button>
              </form>
            );
          })}
        </div>
      </SectionCard>

      {/* 6. Expense ledger. */}
      <SectionCard title="Expense ledger" className="mb-4">
        <form action={addFinanceEntry} className="grid gap-3 sm:grid-cols-3">
          <label className="text-[11px] text-ink-muted">
            Date
            <input
              name="entry_date"
              type="date"
              required
              defaultValue={today}
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
          </label>
          <label className="text-[11px] text-ink-muted">
            Type
            <select
              name="type"
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            >
              <option value="opex">opex</option>
              <option value="capex">capex</option>
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Category
            <input
              name="category"
              required
              placeholder="e.g. Payroll, Software, Ads"
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
          </label>
          <label className="text-[11px] text-ink-muted">
            Amount (PHP)
            <input
              name="amount"
              type="number"
              required
              placeholder="0"
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
          </label>
          <label className="text-[11px] text-ink-muted">
            Brand (optional)
            <select
              name="brand_id"
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            >
              <option value="">— None —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Note (optional)
            <input
              name="note"
              placeholder="Memo"
              className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
            />
          </label>
          <button
            type="submit"
            className="mt-1 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-3 sm:w-auto sm:justify-self-start"
          >
            Add expense
          </button>
        </form>
      </SectionCard>

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">
          {archived ? "Archived entries" : "Ledger entries"}
        </h2>
        <ArchivedToggle
          basePath="/finance"
          archived={archived}
          params={{ ...dateParams, h: String(horizon) }}
        />
      </div>
      <TableShell columns={["Date", "Type", "Category", "Brand", "Note", "Amount", "Manage"]}>
        {entries.length === 0 && (
          <tr>
            <td colSpan={7} className="p-4 text-ink-muted">
              No expenses recorded in this period.
            </td>
          </tr>
        )}
        {entries.map((e) => (
          <tr key={e.id} className={rowClass}>
            <td className="p-3 font-mono text-xs text-ink-muted">{e.entry_date}</td>
            <td className="p-3">
              <Badge tone={e.type === "capex" ? "amber" : "muted"}>{e.type}</Badge>
            </td>
            <td className="p-3 text-ink">{e.category ?? "—"}</td>
            <td className="p-3 text-ink-muted">{e.brand_id ? brandName(e.brand_id) : "—"}</td>
            <td className="p-3 text-ink-muted">{e.note ?? "—"}</td>
            <td className="p-3 font-mono text-ink">{peso(Number(e.amount ?? 0))}</td>
            <td className="p-3">
              <RowActions {...rowActionProps("finance_entries", e as unknown as Record<string, unknown>, profile)} />
            </td>
          </tr>
        ))}
      </TableShell>
    </AppShell>
  );
}
