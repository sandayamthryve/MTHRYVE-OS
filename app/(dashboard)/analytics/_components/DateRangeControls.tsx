"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  PRESET_LABELS,
  COMPARE_LABELS,
  type Preset,
  type CompareMode,
} from "@/lib/metrics/dates";

type Brand = { id: string; name: string };

const PRESETS: Preset[] = [
  "today",
  "yesterday",
  "last_7",
  "last_30",
  "mtd",
  "qtd",
  "ytd",
  "custom",
];
const COMPARES: CompareMode[] = ["none", "previous", "mom", "wow", "yoy"];

// The date / compare / brand controls on every dashboard. It owns no "now" — it
// only writes URL params (?preset, ?period_start/end, ?compare, ?brand_id) and
// the server resolves the concrete range, so client and server never disagree.
export function DateRangeControls({
  preset,
  compare,
  brandId,
  periodStart,
  periodEnd,
  brands,
  resolvedStart,
  resolvedEnd,
  showBrand = true,
  showCompare = true,
}: {
  preset: Preset;
  compare: CompareMode;
  brandId: string | null;
  periodStart: string;
  periodEnd: string;
  brands: Brand[];
  resolvedStart: string;
  resolvedEnd: string;
  // Additive, backward-compatible: surfaces that don't wire brand filtering or a
  // comparison read hide those controls so the picker never offers a lever that
  // does nothing. Both default to true, so the analytics dashboards are unchanged.
  showBrand?: boolean;
  showCompare?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(params?.toString() ?? "");
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") next.delete(k);
        else next.set(k, v);
      }
      router.push(`${pathname}?${next.toString()}`);
    },
    [params, pathname, router]
  );

  const onPreset = (p: Preset) => {
    if (p === "custom") {
      // Seed custom inputs with the currently-resolved range so the pickers open
      // on something sensible.
      setParams({ preset: "custom", period_start: resolvedStart, period_end: resolvedEnd });
    } else {
      setParams({ preset: p, period_start: null, period_end: null });
    }
  };

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-3">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPreset(p)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              preset === p
                ? "bg-teal-500/15 text-teal-300"
                : "text-ink-muted hover:bg-charcoal-800 hover:text-ink"
            }`}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      {preset === "custom" && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            defaultValue={periodStart}
            onChange={(e) => setParams({ preset: "custom", period_start: e.target.value })}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-xs text-ink"
          />
          <span className="text-ink-dim">→</span>
          <input
            type="date"
            defaultValue={periodEnd}
            onChange={(e) => setParams({ preset: "custom", period_end: e.target.value })}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-xs text-ink"
          />
        </div>
      )}

      {(showBrand || showCompare) && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {showBrand && (
            <label className="flex items-center gap-1.5 text-xs text-ink-dim">
              Brand
              <select
                value={brandId ?? "shop"}
                onChange={(e) =>
                  setParams({ brand_id: e.target.value === "shop" ? null : e.target.value })
                }
                className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-xs text-ink"
              >
                <option value="shop">All shops (org-level)</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {showCompare && (
            <label className="flex items-center gap-1.5 text-xs text-ink-dim">
              Compare
              <select
                value={compare}
                onChange={(e) => setParams({ compare: e.target.value === "none" ? null : e.target.value })}
                className="rounded-md border border-charcoal-700 bg-charcoal-950 px-2 py-1.5 text-xs text-ink"
              >
                {COMPARES.map((c) => (
                  <option key={c} value={c}>
                    {COMPARE_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
