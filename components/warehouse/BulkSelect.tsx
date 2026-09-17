"use client";

import { useEffect, useState } from "react";

// Select-all and the live selected count for the Product Master bulk bar.
//
// The checkboxes themselves are server-rendered in the table and bound to the
// bulk form by its id (the `form` attribute), the same way every per-row edit
// input in that table is already bound to its own row form. That keeps the
// selection in the DOM rather than in React state, so this component only has
// to drive the master checkbox and report the count — no lifting of row state,
// no re-render of a table that the server owns.
export function BulkSelect({ formId }: { formId: string }) {
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);

  const boxes = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${formId}"]`)
    );

  const sync = () => {
    const all = boxes();
    setTotal(all.length);
    setCount(all.filter((b) => b.checked).length);
  };

  useEffect(() => {
    sync();
    // The rows re-render on every filter change and on a server action's
    // revalidate, so listen on the document rather than binding each box.
    const onChange = (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      if (target?.name === "ids" && target.getAttribute("form") === formId) sync();
    };
    document.addEventListener("change", onChange);
    return () => document.removeEventListener("change", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  const toggleAll = (checked: boolean) => {
    for (const box of boxes()) box.checked = checked;
    sync();
  };

  return (
    <div className="flex items-center gap-2">
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-ink-muted">
        <input
          type="checkbox"
          checked={total > 0 && count === total}
          // Some but not all — the box shows neither state honestly, so mark it.
          ref={(el) => {
            if (el) el.indeterminate = count > 0 && count < total;
          }}
          onChange={(event) => toggleAll(event.target.checked)}
          className="h-3.5 w-3.5 accent-teal-400"
        />
        Select all
      </label>
      <span className="text-[11px] font-bold text-ink">
        {count} selected
      </span>
    </div>
  );
}
