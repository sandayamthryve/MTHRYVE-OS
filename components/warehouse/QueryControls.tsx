"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

// Client-side query-param controls for the Warehouse surfaces. Changing a
// control updates the URL search params via a soft navigation (router.replace,
// scroll: false) — the server component re-renders with fresh data and NO full
// page reload, which is the "instant refresh" the brand dropdowns call for.

const selectCls =
  "mt-1 block rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";
const inputCls =
  "mt-1 block w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";

function useSetParam() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  return useCallback(
    (name: string, value: string, resetKeys: string[] = []) => {
      const next = new URLSearchParams(params?.toString() ?? "");
      if (value) next.set(name, value);
      else next.delete(name);
      for (const k of resetKeys) next.delete(k);
      startTransition(() => {
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      });
    },
    [router, pathname, params]
  );
}

// A labelled <select> bound to one query param. Options are {value,label}.
export function QuerySelect({
  name,
  label,
  value,
  options,
  resetKeys,
}: {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  resetKeys?: string[];
}) {
  const setParam = useSetParam();
  return (
    <label className="text-[11px] text-ink-muted">
      {label}
      <select
        className={selectCls}
        defaultValue={value}
        onChange={(e) => setParam(name, e.target.value, resetKeys)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// A debounced search box bound to one query param — updates the URL ~300ms after
// the user stops typing, so results refresh without a submit button or reload.
export function QuerySearch({
  name,
  label,
  value,
  placeholder,
  className = "",
}: {
  name: string;
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
}) {
  const setParam = useSetParam();
  const [text, setText] = useState(value);

  // Keep the input in sync if the URL changes underneath us (e.g. brand switch).
  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== value) setParam(name, text.trim());
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <label className={`text-[11px] text-ink-muted ${className}`}>
      {label}
      <input
        className={inputCls}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
