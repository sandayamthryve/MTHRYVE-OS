"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// The single-dashboard brand selector for the Clients page. Writes the chosen
// brand id to the `?brand=` search param (preserving any other params, e.g. the
// window `?w=`) and pushes — the server page re-reads and swaps every section to
// the selected brand. One dropdown drives the whole dashboard, so there is one
// place to view any brand's commerce view rather than a page per brand.

export type BrandOption = { id: string; name: string };

export function BrandSwitcher({
  brands,
  current,
  param = "brand",
}: {
  brands: BrandOption[];
  current: string;
  param?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(id: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set(param, id);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <label className="inline-flex items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">Client</span>
      <select
        value={current}
        onChange={(e) => select(e.target.value)}
        className="rounded-md border border-charcoal-700 bg-charcoal-950 px-3 py-1.5 text-sm text-ink focus:border-teal-500 focus:outline-none"
      >
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}
