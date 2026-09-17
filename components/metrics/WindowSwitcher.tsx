"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// A compact segmented control for the standardized metric windows. Writes the
// chosen key to the `?w=` search param (preserving any other params) and pushes
// — the server page re-reads with the new window. One control, reused by every
// GMV surface so the window vocabulary is identical everywhere.

const OPTIONS: { key: string; label: string }[] = [
  { key: "mtd", label: "MTD" },
  { key: "last7", label: "7d" },
  { key: "last30", label: "30d" },
  { key: "month", label: "Month" },
];

export function WindowSwitcher({ current, param = "w" }: { current: string; param?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(key: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set(param, key);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="inline-flex overflow-hidden rounded-md border border-charcoal-700 bg-charcoal-950">
      {OPTIONS.map((o) => {
        const active = o.key === current;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => select(o.key)}
            aria-pressed={active}
            className={`px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
              active
                ? "bg-teal-500 text-charcoal-950"
                : "text-ink-muted hover:bg-charcoal-800 hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
