"use client";

// Filters for the Creative Studio → Library tab: an org-wide gallery over
// content_assets. Changing brand or kind navigates with updated query params
// while staying on the Library tab, so the URL is the whole state (deep-linkable
// and back-button friendly). "All" on either axis clears that filter.
import { useRouter } from "next/navigation";
import { ASSET_KINDS, ASSET_KIND_SINGULAR } from "@/lib/content/assets";

type BrandOption = { id: string; name: string };

export function LibraryFilters({
  brands,
  brand,
  kind,
}: {
  brands: BrandOption[];
  brand: string;
  kind: string;
}) {
  const router = useRouter();

  function push(next: { brand?: string; kind?: string }) {
    const params = new URLSearchParams();
    params.set("tab", "library");
    const b = next.brand ?? brand;
    const k = next.kind ?? kind;
    if (b) params.set("brand", b);
    if (k) params.set("kind", k);
    router.push(`/creative-studio?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        value={brand}
        onChange={(e) => push({ brand: e.target.value })}
        aria-label="Filter assets by brand"
        className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
      >
        <option value="">All brands</option>
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>

      <select
        value={kind}
        onChange={(e) => push({ kind: e.target.value })}
        aria-label="Filter assets by kind"
        className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink"
      >
        <option value="">All kinds</option>
        {ASSET_KINDS.map((k) => (
          <option key={k} value={k}>
            {ASSET_KIND_SINGULAR[k]}
          </option>
        ))}
      </select>
    </div>
  );
}
