"use client";

// "Add lead" form for the Leads / CRM (BizDev) page. Mounts <SnapFill> (paste +
// photo) with the BizDev lead field whitelist: paste a row / "Label: value" lines,
// or snap a photo of a business card / DM, and it pre-fills the whitelisted inputs
// as editable suggestions. SnapFill only fills — the createLead server action still
// does the write (same role-gate, honest nulls), so nothing saves until submit.

import { useState } from "react";
import { SnapFill } from "@/components/snapfill/SnapFill";
import { LEAD_SNAP_FIELDS } from "@/lib/snapfill/schema";

const fieldCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

const CONTROLLED_KEYS = ["name", "company", "email", "phone", "source", "value", "notes"] as const;
type ControlledKey = (typeof CONTROLLED_KEYS)[number];
type Values = Record<ControlledKey, string>;
const EMPTY: Values = { name: "", company: "", email: "", phone: "", source: "", value: "", notes: "" };

export function AddLeadForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const [values, setValues] = useState<Values>(EMPTY);
  const [filled, setFilled] = useState<Set<string>>(new Set());

  function set(key: ControlledKey, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function applyFill(result: { values: Record<string, string> }) {
    setValues((prev) => {
      const next = { ...prev };
      for (const k of CONTROLLED_KEYS) {
        if (result.values[k] !== undefined) next[k] = result.values[k];
      }
      return next;
    });
    setFilled(new Set(Object.keys(result.values)));
  }

  const cls = (key: ControlledKey) => `${fieldCls} ${filled.has(key) ? "border-amber-500/60 bg-amber-500/5" : ""}`;

  return (
    <form action={action} className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
      <div className="mb-4">
        <SnapFill target="BizDev lead" schema={LEAD_SNAP_FIELDS} onFill={applyFill} modes={["paste", "photo"]} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <input name="name" required placeholder="Lead / contact name" className={cls("name")} value={values.name} onChange={(e) => set("name", e.target.value)} />
        <input name="company" placeholder="Company / brand" className={cls("company")} value={values.company} onChange={(e) => set("company", e.target.value)} />
        <input name="email" placeholder="Email" className={cls("email")} value={values.email} onChange={(e) => set("email", e.target.value)} />
        <input name="phone" placeholder="Phone" className={cls("phone")} value={values.phone} onChange={(e) => set("phone", e.target.value)} />
        <input name="source" placeholder="Source (e.g. TikTok, referral)" className={cls("source")} value={values.source} onChange={(e) => set("source", e.target.value)} />
        <select name="department" className={fieldCls}>
          <option value="Business Development">Business Development</option>
          <option value="Affiliate">Affiliate</option>
        </select>
        <input name="value" type="number" placeholder="Est. value (PHP)" className={cls("value")} value={values.value} onChange={(e) => set("value", e.target.value)} />
        <input name="notes" placeholder="Notes" className={`${cls("notes")} sm:col-span-2`} value={values.notes} onChange={(e) => set("notes", e.target.value)} />
      </div>
      <button type="submit" className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
        Add lead
      </button>
    </form>
  );
}
