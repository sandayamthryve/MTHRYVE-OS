"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// The new-expense encoding form. COO only (the page gates render; RLS is the
// real boundary). Everything money-shaped is previewed client-side but the DB
// owns the two derived fields: expense_code (trigger) and net_amount (a
// GENERATED column). We only ever send gross_amount + vat_amount — never the
// code or the net.
//
// VAT helper: with "VAT applicable" on and a gross entered, the 12% VAT is
// suggested as gross / 1.12 * 0.12 (the VAT baked into a VAT-inclusive gross).
// The suggestion recomputes as the gross changes but stays fully editable — a
// manual override sticks until the gross changes again. Net = gross − VAT is
// shown live and is NEVER submitted; the DB recomputes it on write.

export type CategoryOption = {
  id: string;
  group_name: string;
  name: string;
};

export type Option = { id: string; name: string };

const PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: "", label: "— Not set —" },
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "gcash", label: "GCash" },
  { value: "credit_card", label: "Credit card" },
  { value: "petty_cash", label: "Petty cash" },
  { value: "other", label: "Other" },
];

const ALLOCATIONS: { value: string; label: string }[] = [
  { value: "brand", label: "Brand" },
  { value: "department", label: "Department" },
  { value: "business_unit", label: "Business unit" },
  { value: "shared", label: "Shared / overhead" },
];

const ONEOFF = "__oneoff__";

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";
const labelCls = "text-[11px] text-ink-muted";

function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "PHP",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `PHP ${n.toFixed(2)}`;
  }
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function todayManila(): string {
  // The company runs on Asia/Manila; default the date to "today" there so a
  // late-night encode doesn't land on yesterday/tomorrow via UTC drift.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type Result = {
  expense_code: string | null;
  net_amount: number | null;
  attached: number;
  attach_errors: string[];
};

export function NewExpenseForm({
  categories,
  vendors,
  brands,
  departments,
  campaigns,
}: {
  categories: CategoryOption[];
  vendors: Option[];
  brands: Option[];
  departments: Option[];
  campaigns: Option[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [transactionDate, setTransactionDate] = useState<string>(todayManila());
  const [type, setType] = useState<"OPEX" | "CAPEX">("OPEX");
  const [categoryId, setCategoryId] = useState<string>("");
  const [allocation, setAllocation] = useState<string>("brand");
  const [brandId, setBrandId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  // Independent of allocation: a campaign can be run by a department or for a
  // brand, so it is not cleared when those switch.
  const [campaignId, setCampaignId] = useState<string>("");
  const [vendorChoice, setVendorChoice] = useState<string>(""); // vendor id, ONEOFF, or ""
  const [vendorOneoff, setVendorOneoff] = useState<string>("");
  const [referenceNumber, setReferenceNumber] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<string>("");
  const [remarks, setRemarks] = useState<string>("");

  const [gross, setGross] = useState<string>("");
  const [vatApplicable, setVatApplicable] = useState<boolean>(true);
  const [vat, setVat] = useState<string>("");
  // Once the user types into the VAT field, stop auto-overwriting it on gross
  // changes — until they clear it or re-toggle VAT.
  const [vatTouched, setVatTouched] = useState<boolean>(false);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const grossNum = useMemo(() => {
    const n = Number(gross);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [gross]);

  const suggestedVat = useMemo(
    () => (vatApplicable && grossNum > 0 ? round2((grossNum / 1.12) * 0.12) : 0),
    [vatApplicable, grossNum]
  );

  // The VAT value actually in play: the manual entry if touched, else the
  // suggestion (0 when VAT is not applicable).
  const vatNum = useMemo(() => {
    if (!vatApplicable) return 0;
    if (vatTouched) {
      const n = Number(vat);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    }
    return suggestedVat;
  }, [vatApplicable, vatTouched, vat, suggestedVat]);

  const netNum = round2(Math.max(0, grossNum - vatNum));

  // What lands in the VAT input: the manual value once touched, else the live
  // suggestion string so the field visibly tracks the gross.
  const vatFieldValue = vatApplicable
    ? vatTouched
      ? vat
      : suggestedVat > 0
      ? String(suggestedVat)
      : ""
    : "";

  function onToggleVat(next: boolean) {
    setVatApplicable(next);
    setVatTouched(false);
    if (!next) setVat("");
  }

  // Group categories by group_name for the <optgroup> dropdown, preserving the
  // server's sort order within each group.
  const grouped = useMemo(() => {
    const map = new Map<string, CategoryOption[]>();
    for (const c of categories) {
      const arr = map.get(c.group_name) ?? [];
      arr.push(c);
      map.set(c.group_name, arr);
    }
    return Array.from(map.entries());
  }, [categories]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!transactionDate) return setError("Pick a transaction date.");
    if (grossNum <= 0) return setError("Enter a gross amount greater than zero.");
    if (allocation === "brand" && !brandId) return setError("Pick a brand for a brand-allocated expense.");
    if (allocation === "department" && !departmentId)
      return setError("Pick a department for a department-allocated expense.");

    const fd = new FormData();
    fd.set("transaction_date", transactionDate);
    fd.set("type", type);
    if (categoryId) fd.set("category_id", categoryId);
    fd.set("allocation", allocation);
    if (allocation === "brand" && brandId) fd.set("brand_id", brandId);
    if (allocation === "department" && departmentId) fd.set("department_id", departmentId);
    if (vendorChoice && vendorChoice !== ONEOFF) fd.set("vendor_id", vendorChoice);
    else if (vendorChoice === ONEOFF && vendorOneoff.trim())
      fd.set("vendor_name_oneoff", vendorOneoff.trim());
    if (referenceNumber.trim()) fd.set("reference_number", referenceNumber.trim());
    fd.set("gross_amount", String(grossNum));
    fd.set("vat_amount", String(vatNum));
    if (paymentMethod) fd.set("payment_method", paymentMethod);
    if (remarks.trim()) fd.set("remarks", remarks.trim());

    const files = fileRef.current?.files;
    if (files) for (let i = 0; i < files.length; i++) fd.append("files", files[i]);

    setPending(true);
    try {
      const res = await fetch("/api/finance/expenses", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        setError(json?.error || "Could not save the expense.");
        return;
      }
      setResult({
        expense_code: json.expense_code ?? null,
        net_amount: json.net_amount ?? null,
        attached: json.attached ?? 0,
        attach_errors: json.attach_errors ?? [],
      });
      // Reset the money + evidence fields for the next encode; keep date/type.
      setGross("");
      setVat("");
      setVatTouched(false);
      setVendorChoice("");
      setVendorOneoff("");
      setReferenceNumber("");
      setRemarks("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      setError("Network error — the expense was not saved. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3">
      {/* Row 1 — date, type, category */}
      <label className={labelCls}>
        Transaction date
        <input
          type="date"
          required
          value={transactionDate}
          onChange={(e) => setTransactionDate(e.target.value)}
          className={inputCls}
        />
      </label>
      <label className={labelCls}>
        Type
        <select
          value={type}
          onChange={(e) => setType(e.target.value === "CAPEX" ? "CAPEX" : "OPEX")}
          className={inputCls}
        >
          <option value="OPEX">OPEX — operating</option>
          <option value="CAPEX">CAPEX — capital</option>
        </select>
      </label>
      <label className={labelCls}>
        Category
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className={inputCls}
        >
          <option value="">— Select category —</option>
          {grouped.map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {/* Row 2 — allocation + its scoped target (brand or department) */}
      <label className={labelCls}>
        Allocation
        <select
          value={allocation}
          onChange={(e) => setAllocation(e.target.value)}
          className={inputCls}
        >
          {ALLOCATIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      {allocation === "brand" ? (
        <label className={labelCls}>
          Brand
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className={inputCls}
          >
            <option value="">— Select brand —</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      ) : allocation === "department" ? (
        <label className={labelCls}>
          Department
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            className={inputCls}
          >
            <option value="">— Select department —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className={labelCls}>
          <span className="block">Cost center</span>
          <p className="mt-1 rounded-md border border-charcoal-700/60 bg-charcoal-950/40 p-2.5 text-xs text-ink-muted">
            {allocation === "shared"
              ? "Shared / overhead — no single brand or department."
              : "Business-unit level — no single brand or department."}
          </p>
        </div>
      )}

      <label className={labelCls}>
        Campaign <span className="text-ink-dim">(optional)</span>
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={inputCls}>
          <option value="">— none —</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <input type="hidden" name="campaign_id" value={campaignId} />

      {/* Row 3 — vendor (+ one-time fallback), reference number */}
      <label className={labelCls}>
        Vendor
        <select
          value={vendorChoice}
          onChange={(e) => setVendorChoice(e.target.value)}
          className={inputCls}
        >
          <option value="">— None —</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
          <option value={ONEOFF}>+ One-time vendor…</option>
        </select>
      </label>
      {vendorChoice === ONEOFF ? (
        <label className={labelCls}>
          One-time vendor name
          <input
            type="text"
            value={vendorOneoff}
            onChange={(e) => setVendorOneoff(e.target.value)}
            placeholder="e.g. Mang Juan Hardware"
            className={inputCls}
          />
        </label>
      ) : (
        <label className={labelCls}>
          Reference no. (optional)
          <input
            type="text"
            value={referenceNumber}
            onChange={(e) => setReferenceNumber(e.target.value)}
            placeholder="OR / invoice no."
            className={inputCls}
          />
        </label>
      )}
      {vendorChoice === ONEOFF && (
        <label className={labelCls}>
          Reference no. (optional)
          <input
            type="text"
            value={referenceNumber}
            onChange={(e) => setReferenceNumber(e.target.value)}
            placeholder="OR / invoice no."
            className={inputCls}
          />
        </label>
      )}

      {/* Row 4 — the VAT helper: gross, VAT (suggested/editable), net (live) */}
      <label className={labelCls}>
        Gross amount (PHP)
        <input
          type="number"
          min="0"
          step="0.01"
          required
          value={gross}
          onChange={(e) => setGross(e.target.value)}
          placeholder="0.00"
          className={inputCls}
        />
      </label>
      <div className={labelCls}>
        <div className="flex items-center justify-between">
          <span>VAT amount (PHP)</span>
          <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <input
              type="checkbox"
              checked={vatApplicable}
              onChange={(e) => onToggleVat(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-charcoal-700 bg-charcoal-950 accent-teal-500"
            />
            VAT applicable
          </label>
        </div>
        <input
          type="number"
          min="0"
          step="0.01"
          disabled={!vatApplicable}
          value={vatFieldValue}
          onChange={(e) => {
            setVatTouched(true);
            setVat(e.target.value);
          }}
          placeholder={vatApplicable ? "0.00" : "n/a"}
          className={`${inputCls} disabled:opacity-50`}
        />
        {vatApplicable && grossNum > 0 && (
          <p className="mt-1 text-[11px] text-ink-dim">
            Suggested 12%: {peso(suggestedVat)} (of a VAT-inclusive gross). Editable.
          </p>
        )}
      </div>
      <div className={labelCls}>
        <span className="block">Net amount (computed)</span>
        <div className="mt-1 flex h-[42px] items-center rounded-md border border-charcoal-700/60 bg-charcoal-950/40 px-2.5 font-mono text-sm text-ink">
          {grossNum > 0 ? peso(netNum) : "—"}
        </div>
        <p className="mt-1 text-[11px] text-ink-dim">Gross − VAT. The DB recomputes on save.</p>
      </div>

      {/* Row 5 — payment method, OR/invoice, remarks */}
      <label className={labelCls}>
        Payment method (optional)
        <select
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value)}
          className={inputCls}
        >
          {PAYMENT_METHODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        OR / invoice (optional)
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-xs text-ink-muted file:mr-3 file:rounded file:border-0 file:bg-charcoal-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-teal-300 hover:file:bg-charcoal-700"
        />
      </label>
      <label className={labelCls}>
        Remarks (optional)
        <input
          type="text"
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="Memo"
          className={inputCls}
        />
      </label>

      <div className="sm:col-span-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Encode expense"}
        </button>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        {result && (
          <div className="mt-2 rounded-md border border-teal-500/40 bg-teal-500/10 p-3 text-sm text-teal-200">
            Saved{" "}
            <span className="font-mono font-semibold">{result.expense_code ?? "(code pending)"}</span>{" "}
            — net{" "}
            <span className="font-mono">
              {result.net_amount != null ? peso(Number(result.net_amount)) : "—"}
            </span>
            {result.attached > 0 && (
              <>
                {" "}
                · {result.attached} attachment{result.attached === 1 ? "" : "s"}
              </>
            )}
            .
            {result.attach_errors.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-300">
                {result.attach_errors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
