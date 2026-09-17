"use client";

// "Add a product" is the ONLY single-row path that INSERTs a new `products` row.
// The inline row editor (updateProduct) always UPDATEs by id and can never insert,
// so a duplicate SKU can only ever be born here. The server action guards against
// that by blocking a second product with the same SKU under the same brand in the
// org; that block is surfaced inline via useFormState rather than thrown, so the
// operator gets a clear "already exists — open it to edit" instead of a silent
// failure or a duplicate row. The unique index on (org_id, brand_id, sku) is the
// DB-level backstop.

import { useFormState, useFormStatus } from "react-dom";

export type AddProductState = { error: string } | null;

type Brand = { id: string; name: string };
type Status = { value: string; label: string };

const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 disabled:opacity-60"
    >
      {pending ? "Adding…" : "Add product"}
    </button>
  );
}

export function AddProductForm({
  action,
  brands,
  statuses,
}: {
  action: (prev: AddProductState, formData: FormData) => Promise<AddProductState>;
  brands: readonly Brand[];
  statuses: readonly Status[];
}) {
  const [state, formAction] = useFormState(action, null);

  return (
    <form action={formAction}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          SKU <span className="text-red-300">*</span>
          <input name="sku" required className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Product name
          <input name="product_name" className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Variant
          <input name="variant" className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Barcode
          <input name="barcode" className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Warehouse location
          <input name="warehouse_location" className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Category
          <input name="category" className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Cost (PHP)
          <input name="cost" type="number" step="0.01" min={0} className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Selling price (PHP)
          <input name="selling_price" type="number" step="0.01" min={0} className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Reorder point
          <input name="reorder_point" type="number" min={0} className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Opening stock on hand
          <input name="stock" type="number" min={0} placeholder="optional" className={inputCls} />
        </label>
        <label className="text-[11px] text-ink-muted">
          Status
          <select name="status" defaultValue="active" className={inputCls}>
            {statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-ink-muted sm:col-span-2 lg:col-span-3">
          Notes
          <input name="notes" className={inputCls} />
        </label>
        <div className="flex items-end">
          <SubmitButton />
        </div>
      </div>
      {state?.error && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
          {state.error}
        </p>
      )}
    </form>
  );
}
