import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, SectionCard, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireProfile, requireRole, requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { WarehouseTabs } from "@/components/warehouse/WarehouseTabs";
import { ReturnsCsvButton } from "./ReturnsCsvButton";
import { ImportReturnsControl, type ImportReturnsState } from "./ImportReturnsControl";
import { DeleteCaseButton } from "./DeleteCaseButton";
import { DateRangeControls } from "../analytics/_components/DateRangeControls";
import { resolveDateRange, type DateRangeSearchParams } from "@/lib/metrics/range-params";
import { syncRestockFromReturn } from "@/lib/warehouse/restock";
import type { Shim } from "@/lib/warehouse/inventory";

type Brand = { id: string; name: string };
type User = { id: string; full_name: string };
type ReturnCase = {
  id: string;
  brand_id: string | null;
  platform: string | null;
  order_ref: string | null;
  sku: string | null;
  product_name: string | null;
  units: number | null;
  value: number | null;
  currency: string | null;
  reason: string | null;
  fault: string | null;
  status: string | null;
  csr_owner: string | null;
  reported_date: string | null;
  resolved_date: string | null;
  note: string | null;
  created_at: string;
};

type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown> | Record<string, unknown>[]) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
    delete: () => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

const REASONS: { value: string; label: string }[] = [
  { value: "wrong_missing_shortship", label: "Wrong / missing / short-shipped" },
  { value: "damaged_transit", label: "Damaged in transit" },
  { value: "defective_quality", label: "Defective / quality" },
  { value: "rts_undelivered", label: "RTS — undelivered / COD refused" },
  { value: "change_of_mind", label: "Change of mind" },
  { value: "other", label: "Other" },
];
const FAULTS: { value: string; label: string }[] = [
  { value: "warehouse", label: "Warehouse" },
  { value: "courier", label: "Courier" },
  { value: "customer", label: "Customer" },
  { value: "listing", label: "Listing" },
  { value: "supplier", label: "Supplier" },
  { value: "unknown", label: "Unknown" },
];
const PLATFORMS: { value: string; label: string }[] = [
  { value: "tiktok_shop", label: "TikTok Shop" },
  { value: "shopee", label: "Shopee" },
  { value: "lazada", label: "Lazada" },
  { value: "other", label: "Other" },
];
const STATUSES: { value: string; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "received", label: "Received" },
  { value: "refunded", label: "Refunded" },
  { value: "restocked", label: "Restocked" },
  { value: "disputed", label: "Disputed" },
  { value: "closed", label: "Closed" },
];

const REASON_LABEL = new Map(REASONS.map((r) => [r.value, r.label]));
const FAULT_LABEL = new Map(FAULTS.map((f) => [f.value, f.label]));
const PLATFORM_LABEL = new Map(PLATFORMS.map((p) => [p.value, p.label]));
const STATUS_LABEL = new Map(STATUSES.map((s) => [s.value, s.label]));

const REASON_SET = new Set(REASONS.map((r) => r.value));
const FAULT_SET = new Set(FAULTS.map((f) => f.value));
const PLATFORM_SET = new Set(PLATFORMS.map((p) => p.value));
const STATUS_SET = new Set(STATUSES.map((s) => s.value));

const SETTLED = new Set(["refunded", "restocked", "closed"]);
const ACTIVE = new Set(["open", "received"]);

import type { BadgeTone } from "@/components/ui";

function statusTone(s: string | null): BadgeTone {
  switch (s) {
    case "refunded":
    case "restocked":
      return "teal";
    case "open":
      return "amber";
    case "received":
      return "violet";
    case "disputed":
      return "red";
    default:
      return "muted";
  }
}

function faultTone(f: string | null): BadgeTone {
  if (f === "warehouse") return "red";
  if (f === "courier" || f === "supplier") return "amber";
  return "muted";
}

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

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isDate(s?: string): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function num(v: FormDataEntryValue | null, fallback = 0): number {
  const n = Number(v ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function daysOpen(reported: string | null, today: Date): number {
  if (!isDate(reported ?? undefined)) return 0;
  const [y, m, d] = (reported as string).split("-").map(Number);
  const then = new Date(y, m - 1, d);
  const ms = today.getTime() - then.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// --- Server actions ---

async function saveReturnCase(formData: FormData) {
  "use server";
  const profile = await requireProfile();

  const platform = String(formData.get("platform") ?? "other");
  const reason = String(formData.get("reason") ?? "other");
  const status = String(formData.get("status") ?? "open");
  const faultRaw = String(formData.get("fault") ?? "");
  const brand_id = String(formData.get("brand_id") ?? "") || null;
  const csr_owner = String(formData.get("csr_owner") ?? "") || null;
  const reported = String(formData.get("reported_date") ?? "");

  const sku = String(formData.get("sku") ?? "").trim() || null;
  const orderRef = String(formData.get("order_ref") ?? "").trim() || null;
  const units = Math.round(num(formData.get("units"), 1)) || 1;
  const finalStatus = STATUS_SET.has(status) ? status : "open";

  const supabase = createServerSupabaseClient();
  const created = await (supabase as unknown as Shim)
    .from("return_cases")
    .insert({
      org_id: profile.org_id,
      created_by: profile.id,
      brand_id,
      platform: PLATFORM_SET.has(platform) ? platform : "other",
      order_ref: orderRef,
      sku,
      product_name: String(formData.get("product_name") ?? "").trim() || null,
      units,
      value: num(formData.get("value"), 0),
      currency: "PHP",
      reason: REASON_SET.has(reason) ? reason : "other",
      fault: FAULT_SET.has(faultRaw) ? faultRaw : null,
      status: finalStatus,
      csr_owner,
      reported_date: isDate(reported) ? reported : fmtDate(new Date()),
      note: String(formData.get("note") ?? "").trim() || null,
    })
    .select("id")
    .single();

  const newId = (created?.data as { id: string } | null)?.id ?? null;
  if (finalStatus === "restocked" && newId) {
    await syncRestockFromReturn(supabase as unknown as Shim, {
      orgId: profile.org_id,
      caseId: newId,
      sku,
      brandId: brand_id,
      units,
      reference: orderRef,
    });
    revalidatePath("/warehouse/stock");
    revalidatePath("/warehouse/overview");
    revalidatePath("/warehouse/intelligence");
  }
  revalidatePath("/warehouse");
}

async function updateReturnCase(formData: FormData) {
  "use server";
  const profile = await requireProfile();
  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const statusRaw = String(formData.get("status") ?? "");
  const faultRaw = String(formData.get("fault") ?? "");
  const ownerRaw = String(formData.get("csr_owner") ?? "");
  const status = STATUS_SET.has(statusRaw) ? statusRaw : "open";

  const supabase = createServerSupabaseClient();
  const patch: Record<string, unknown> = {
    status,
    fault: FAULT_SET.has(faultRaw) ? faultRaw : null,
    csr_owner: ownerRaw || null,
  };

  const { data: existing } = await supabase
    .from("return_cases")
    .select("resolved_date, sku, units, brand_id, order_ref")
    .eq("id", id)
    .single();
  const ex = existing as unknown as {
    resolved_date: string | null;
    sku: string | null;
    units: number | null;
    brand_id: string | null;
    order_ref: string | null;
  } | null;

  if (["refunded", "restocked", "disputed", "closed"].includes(status) && !ex?.resolved_date) {
    patch.resolved_date = fmtDate(new Date());
  }

  await (supabase as unknown as DbShim).from("return_cases").update(patch).eq("id", id);

  if (status === "restocked") {
    await syncRestockFromReturn(supabase as unknown as Shim, {
      orgId: profile.org_id,
      caseId: id,
      sku: ex?.sku ?? null,
      brandId: ex?.brand_id ?? null,
      units: ex?.units ?? null,
      reference: ex?.order_ref ?? null,
    });
    revalidatePath("/warehouse/stock");
    revalidatePath("/warehouse/overview");
    revalidatePath("/warehouse/intelligence");
  }
  revalidatePath("/warehouse");
}

async function deleteReturnCase(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head"]);
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("return_cases").delete().eq("id", id);
  revalidatePath("/warehouse");
}

async function importReturnCases(
  _prev: ImportReturnsState,
  formData: FormData
): Promise<ImportReturnsState> {
  "use server";
  const profile = await requireRole(["ceo", "coo", "department_head"]);

  const file = formData.get("file");
  let text = "";
  if (file && typeof file !== "string" && file.size > 0) {
    text = await file.text();
  } else {
    text = String(formData.get("csv") ?? "");
  }

  const skipped: string[] = [];
  if (!text.trim()) return { imported: 0, skipped };

  const supabase = createServerSupabaseClient();

  const { data: brandRows } = await supabase
    .from("brands")
    .select("id, name")
    .eq("org_id", profile.org_id);
  const brands = (brandRows ?? []) as unknown as Brand[];
  const brandIdByName = new Map(brands.map((b) => [b.name.trim().toLowerCase(), b.id]));

  const today = fmtDate(new Date());
  const rows: Record<string, unknown>[] = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    if (!raw.trim()) continue;
    const cols = parseCsvLine(raw);
    const order_ref = (cols[0] ?? "").trim();
    if (order_ref.toLowerCase() === "order_ref") continue;

    const brandName = (cols[1] ?? "").trim();
    const platform = (cols[2] ?? "").trim().toLowerCase();
    const product_name = (cols[3] ?? "").trim();
    const sku = (cols[4] ?? "").trim();
    const unitsRaw = (cols[5] ?? "").trim();
    const valueRaw = (cols[6] ?? "").trim();
    const reason = (cols[7] ?? "").trim().toLowerCase();
    const fault = (cols[8] ?? "").trim().toLowerCase();
    const status = (cols[9] ?? "").trim().toLowerCase();
    const reported = (cols[10] ?? "").trim();
    const note = (cols[11] ?? "").trim();

    if (!order_ref && !product_name && !sku) {
      skipped.push(`line ${lineNo}: empty row`);
      continue;
    }

    const brand_id = brandName ? brandIdByName.get(brandName.toLowerCase()) ?? null : null;
    const units = Math.round(Number(unitsRaw));
    const value = Number(valueRaw);

    rows.push({
      org_id: profile.org_id,
      created_by: profile.id,
      brand_id,
      platform: PLATFORM_SET.has(platform) ? platform : "other",
      order_ref: order_ref || null,
      sku: sku || null,
      product_name: product_name || null,
      units: Number.isFinite(units) && units > 0 ? units : 1,
      value: Number.isFinite(value) ? value : 0,
      currency: "PHP",
      reason: REASON_SET.has(reason) ? reason : "other",
      fault: FAULT_SET.has(fault) ? fault : null,
      status: STATUS_SET.has(status) ? status : "open",
      reported_date: isDate(reported) ? reported : today,
      note: note || null,
    });
  }

  const db = supabase as unknown as DbShim;
  if (rows.length > 0) {
    await db.from("return_cases").insert(rows);
  }
  revalidatePath("/warehouse");
  return { imported: rows.length, skipped };
}

// --- Rollup helper ---

type Rollup = { key: string; label: string; count: number; value: number };

function rollupBy(
  cases: ReturnCase[],
  keyOf: (c: ReturnCase) => string | null,
  labelOf: (k: string) => string,
  limit?: number
): Rollup[] {
  const map = new Map<string, Rollup>();
  for (const c of cases) {
    const key = keyOf(c);
    if (!key) continue;
    const cur = map.get(key) ?? { key, label: labelOf(key), count: 0, value: 0 };
    cur.count += 1;
    cur.value += Number(c.value ?? 0);
    map.set(key, cur);
  }
  const list = Array.from(map.values()).sort((a, b) => b.count - a.count || b.value - a.value);
  return typeof limit === "number" ? list.slice(0, limit) : list;
}

function RollupPanel({ title, rows }: { title: string; rows: Rollup[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  return (
    <SectionCard title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No cases in this period.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const pct = max > 0 ? Math.round((r.count / max) * 100) : 0;
            return (
              <div key={r.key}>
                <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                  <span className="truncate text-ink-muted">{r.label}</span>
                  <span className="shrink-0 font-mono text-ink">
                    {r.count} · {peso(r.value)}
                  </span>
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
}

// --- Page ---

export default async function WarehousePage({
  searchParams,
}: {
  searchParams: DateRangeSearchParams;
}) {
  const profile = await requireDepartment(COMMERCE_DEPTS);
  const canManage =
    profile.role === "ceo" || profile.role === "coo" || profile.role === "department_head";
  const supabase = createServerSupabaseClient();

  const dr = resolveDateRange(searchParams, { fallbackPreset: "last_30" });
  const now = new Date();
  const from = dr.range.start;
  const to = dr.range.end;
  const today = fmtDate(now);

  const [brandRes, userRes, caseRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
    supabase
      .from("return_cases")
      .select(
        "id, brand_id, platform, order_ref, sku, product_name, units, value, currency, reason, fault, status, csr_owner, reported_date, resolved_date, note, created_at"
      )
      .is("archived_at", null)
      .gte("reported_date", from)
      .lte("reported_date", to)
      .order("reported_date", { ascending: false })
      .order("created_at", { ascending: false }),
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const users = (userRes.data ?? []) as unknown as User[];
  const cases = (caseRes.data ?? []) as unknown as ReturnCase[];

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const ownerName = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? "";
  const productOf = (c: ReturnCase) => c.product_name?.trim() || c.sku?.trim() || "—";

  const totalCases = cases.length;
  const openCases = cases.filter((c) => !SETTLED.has(c.status ?? "")).length;
  const totalValue = cases.reduce((a, c) => a + Number(c.value ?? 0), 0);
  const warehouseFault = cases.filter((c) => c.fault === "warehouse").length;
  const warehouseFaultPct = totalCases > 0 ? Math.round((warehouseFault / totalCases) * 100) : 0;

  const byFault = rollupBy(
    cases,
    (c) => c.fault ?? "unknown",
    (k) => FAULT_LABEL.get(k) ?? k
  );
  const byReason = rollupBy(
    cases,
    (c) => c.reason ?? "other",
    (k) => REASON_LABEL.get(k) ?? k
  );
  const byBrand = rollupBy(
    cases,
    (c) => c.brand_id,
    (k) => brandName(k),
    8
  );
  const byProduct = rollupBy(
    cases,
    (c) => c.product_name?.trim() || c.sku?.trim() || null,
    (k) => k,
    8
  );

  const followUps = cases
    .filter((c) => ACTIVE.has(c.status ?? ""))
    .map((c) => {
      const days = daysOpen(c.reported_date, now);
      return {
        c,
        days,
        unassigned: !c.csr_owner,
        aging: days > 7,
      };
    })
    .sort((a, b) => Number(b.aging) - Number(a.aging) || b.days - a.days);

  const LOG_CAP = 200;
  const logRows = cases.slice(0, LOG_CAP);

  const exportRows = cases.map((c) => ({
    reported_date: c.reported_date ?? "",
    brand: brandName(c.brand_id) === "—" ? "" : brandName(c.brand_id),
    platform: PLATFORM_LABEL.get(c.platform ?? "") ?? c.platform ?? "",
    order_ref: c.order_ref ?? "",
    product_name: c.product_name ?? "",
    sku: c.sku ?? "",
    units: Number(c.units ?? 0),
    value: Number(c.value ?? 0),
    currency: c.currency ?? "PHP",
    reason: REASON_LABEL.get(c.reason ?? "") ?? c.reason ?? "",
    fault: c.fault ? FAULT_LABEL.get(c.fault) ?? c.fault : "",
    status: STATUS_LABEL.get(c.status ?? "") ?? c.status ?? "",
    csr_owner: ownerName(c.csr_owner),
    reported: c.reported_date ?? "",
    resolved_date: c.resolved_date ?? "",
    note: c.note ?? "",
  }));

  const inputCls =
    "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";
  const rowSelectCls =
    "rounded-md border border-charcoal-700 bg-charcoal-950 p-1.5 text-xs text-ink";

  return (
    <AppShell breadcrumb={["Mthryve OS", "Warehouse"]} profile={profile}>
      <PageHeader
        title="Warehouse — Returns & RTS"
        action={<ReturnsCsvButton rows={exportRows} filename={`returns_${from}_${to}.csv`} />}
      />
      <WarehouseTabs active="returns" />

      <DateRangeControls {...dr.controlProps} brands={[]} showBrand={false} showCompare={false} />

      {/* Summary */}
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open cases" value={openCases} hint="not refunded / restocked / closed" />
        <StatTile label="Return value in period" value={peso(totalValue)} />
        <StatTile label="Cases in period" value={totalCases} />
        <StatTile
          label="Warehouse-fault %"
          value={`${warehouseFaultPct}%`}
          valueClassName={warehouseFaultPct > 0 ? "text-red-300" : "text-ink"}
          hint={`${warehouseFault} of ${totalCases} cases`}
        />
      </div>

      {/* Rollups */}
      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <RollupPanel title="Returns by fault — what to fix" rows={byFault} />
        <RollupPanel title="Returns by reason" rows={byReason} />
        <RollupPanel title="Returns by brand (top 8)" rows={byBrand} />
        <RollupPanel title="Top returned products (top 8)" rows={byProduct} />
      </div>

      {/* Log a new case */}
      <SectionCard title="Log a return / RTS case" className="mb-8">
        <form action={saveReturnCase} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            Platform
            <select name="platform" defaultValue="tiktok_shop" className={inputCls}>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Order ref
            <input name="order_ref" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            Reported date
            <input name="reported_date" type="date" defaultValue={today} className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted lg:col-span-2">
            Product name
            <input name="product_name" className={inputCls} />
          </label>
          <label className="text-[11px] text-ink-muted">
            SKU
            <input name="sku" className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-ink-muted">
              Units
              <input name="units" type="number" min={1} defaultValue={1} className={inputCls} />
            </label>
            <label className="text-[11px] text-ink-muted">
              Value (PHP)
              <input name="value" type="number" step="0.01" defaultValue={0} className={inputCls} />
            </label>
          </div>
          <label className="text-[11px] text-ink-muted">
            Reason
            <select name="reason" defaultValue="other" className={inputCls}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Fault
            <select name="fault" defaultValue="" className={inputCls}>
              <option value="">—</option>
              {FAULTS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            Status
            <select name="status" defaultValue="open" className={inputCls}>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-ink-muted">
            CSR owner
            <select name="csr_owner" defaultValue="" className={inputCls}>
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
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
              Save case
            </button>
          </div>
        </form>
      </SectionCard>

      {/* CSR follow-up */}
      <SectionCard title="CSR follow-up" className="mb-8">
        <p className="mb-3 text-xs text-ink-muted">
          Open and received cases needing attention — <span className="text-amber-300">Aging</span>{" "}
          means reported more than 7 days ago and still unresolved;{" "}
          <span className="text-red-300">Unassigned</span> means no CSR owner yet.
        </p>
        {followUps.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing outstanding in this period.</p>
        ) : (
          <div className="space-y-2">
            {followUps.map(({ c, days, unassigned, aging }) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-ink">{productOf(c)}</span>
                    {aging && <Badge tone="amber">Aging</Badge>}
                    {unassigned && <Badge tone="red">Unassigned</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {brandName(c.brand_id)} · {REASON_LABEL.get(c.reason ?? "") ?? c.reason ?? "—"} ·{" "}
                    {days} {days === 1 ? "day" : "days"} open
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={statusTone(c.status)}>{STATUS_LABEL.get(c.status ?? "") ?? c.status}</Badge>
                  <span className="text-xs text-ink-muted">
                    {c.csr_owner ? ownerName(c.csr_owner) : "Unassigned"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Bulk import */}
      {canManage && (
        <SectionCard title="Import returns (CSV)" className="mb-8">
          <p className="mb-3 text-xs text-ink-muted">
            Bulk-add cases from a spreadsheet. Unknown brands import with no brand; invalid reason /
            fault / status / platform values fall back to defaults rather than being dropped.
          </p>
          <ImportReturnsControl action={importReturnCases} />
        </SectionCard>
      )}

      {/* Case log */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Case log</h2>
        {totalCases > LOG_CAP && (
          <p className="text-xs text-ink-muted">
            Showing newest {LOG_CAP} of {totalCases} — narrow the period to see the rest.
          </p>
        )}
      </div>
      <TableShell
        columns={[
          "Reported",
          "Brand",
          "Platform",
          "Order ref",
          "Product",
          "Units",
          "Value",
          "Reason",
          "Fault",
          "Status / owner",
          ...(canManage ? [""] : []),
        ]}
      >
        {logRows.length === 0 && (
          <tr>
            <td colSpan={canManage ? 11 : 10} className="p-4 text-ink-muted">
              No cases in this period — log the first above.
            </td>
          </tr>
        )}
        {logRows.map((c) => {
          const fid = `rc-${c.id}`;
          return (
           <tr key={c.id} className={rowClass}>
              <td className="whitespace-nowrap font-mono text-xs">{c.reported_date ?? "—"}</td>
              <td>{brandName(c.brand_id)}</td>
              <td>{PLATFORM_LABEL.get(c.platform ?? "") ?? c.platform ?? "—"}</td>
              <td className="font-mono text-xs">{c.order_ref ?? "—"}</td>
              <td className="max-w-[200px] truncate" title={c.product_name ?? undefined}>
                {c.product_name ?? "—"}
                {c.sku && <span className="block font-mono text-[11px] text-ink-muted">{c.sku}</span>}
              </td>
              <td className="font-mono">{c.units ?? 1}</td>
              <td className="font-mono">{peso(Number(c.value ?? 0))}</td>
              <td className="text-xs">{REASON_LABEL.get(c.reason ?? "") ?? c.reason ?? "—"}</td>

              {/* Inline update form for Fault, Status, and Owner */}
              <td colSpan={2}>
                <form id={fid} action={updateReturnCase} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={c.id} />
                  <select
                    name="fault"
                    defaultValue={c.fault ?? ""}
                    onChange={(e) => e.target.form?.requestSubmit()}
                    className={rowSelectCls}
                  >
                    <option value="">(Fault?)</option>
                    {FAULTS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <select
                    name="status"
                    defaultValue={c.status ?? "open"}
                    onChange={(e) => e.target.form?.requestSubmit()}
                    className={rowSelectCls}
                  >
                    {STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <select
                    name="csr_owner"
                    defaultValue={c.csr_owner ?? ""}
                    onChange={(e) => e.target.form?.requestSubmit()}
                    className={rowSelectCls}
                  >
                    <option value="">Unassigned</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name}
                      </option>
                    ))}
                  </select>
                </form>
              </td>

              {/* Action column (Delete) for managers */}
              {canManage && (
                <td className="text-right">
                  <DeleteCaseButton action={deleteReturnCase} caseId={c.id} />
                </td>
              )}
            </tr>
          );
        })}
      </TableShell>
    </AppShell>
  );
}
