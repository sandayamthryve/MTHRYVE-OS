"use client";

// Brand selector for the Creative Studio → Plan tab. Changing the brand
// navigates with an updated ?brand= query param while preserving the current
// ?month=, so every view (calendar, summary, board) stays in sync. "All brands"
// clears the filter.
import { useRouter } from "next/navigation";

type BrandOption = { id: string; name: string };

export function BrandFilter({
  brands,
  selected,
  month,
}: {
  brands: BrandOption[];
  selected: string;
  month: string;
}) {
  const router = useRouter();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const brand = e.target.value;
    const params = new URLSearchParams();
    params.set("tab", "plan");
    if (brand) params.set("brand", brand);
    if (month) params.set("month", month);
    router.push(`/creative-studio?${params.toString()}`);
  }

  return (
    <select
      value={selected}
      onChange={onChange}
      aria-label="Filter by brand"
      className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
    >
      <option value="">All brands</option>
      {brands.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
    </select>
  );
}
