// lib/metrics/range-params.ts — the ONE server-side bridge between a page's URL
// search params and the shared <DateRangeControls> picker.
//
// Every dashboard that mounts the shared date control resolves its window the
// same way through here, so the parse rules (which preset, when a custom range
// wins, how Compare maps to a prior window) live in exactly one place and can't
// drift between surfaces. Nothing here fetches or writes — it only turns
// untrusted query params into a concrete, validated range.
//
// URL scheme (written by DateRangeControls, read here):
//   ?preset=today|yesterday|last_7|last_30|mtd|qtd|ytd|custom
//   ?period_start=YYYY-MM-DD & ?period_end=YYYY-MM-DD   (custom range)
//   ?compare=none|previous|mom|wow|yoy
//   ?brand_id=<uuid>|shop
// Legacy `?from=`/`?to=` (used by the older Live-Ops / Warehouse forms) are
// accepted as aliases for period_start/period_end so existing deep links survive.

import {
  parsePreset,
  parseCompare,
  resolvePreset,
  resolveCompare,
  isValidDate,
  PRESET_LABELS,
  type Preset,
  type CompareMode,
  type Range,
} from "@/lib/metrics/dates";

export interface DateRangeSearchParams {
  preset?: string;
  period_start?: string;
  period_end?: string;
  // Legacy aliases (older bespoke forms) — accepted, never written.
  from?: string;
  to?: string;
  compare?: string;
  brand_id?: string;
}

// Human label for a comparison, keyed the way the delta caption reads it. Kept
// here so every windowed KPI describes its Compare the same way.
export const COMPARE_DELTA_LABEL: Record<CompareMode, string | null> = {
  none: null,
  previous: "vs previous period",
  mom: "vs prev month",
  wow: "vs prev week",
  yoy: "vs prev year",
};

export interface ResolvedDateRange {
  preset: Preset;
  compareMode: CompareMode;
  brandId: string | null;
  range: Range;
  compareRange: Range | null;
  // A short, honest label for the active window — the preset's name, or the
  // explicit "start → end" for a custom range. Safe to render directly.
  rangeLabel: string;
  // The comparison caption ("vs previous period", …) or null when not comparing.
  compareLabel: string | null;
  // Exactly the props <DateRangeControls> expects — spread straight in.
  controlProps: {
    preset: Preset;
    compare: CompareMode;
    brandId: string | null;
    periodStart: string;
    periodEnd: string;
    resolvedStart: string;
    resolvedEnd: string;
  };
}

// Resolve a page's date-range search params into a concrete window + the props
// the shared control needs. `fallbackPreset` lets a surface choose its default
// (trend dashboards → last_7; a single-day floor → today). `now` is injectable
// for tests; it defaults to the request instant.
export function resolveDateRange(
  sp: DateRangeSearchParams | undefined,
  opts: { fallbackPreset?: Preset; now?: Date } = {}
): ResolvedDateRange {
  const now = opts.now ?? new Date();
  const fallback = opts.fallbackPreset ?? "last_7";

  // Explicit custom dates: prefer period_start/period_end; fall back to from/to.
  const startParam = isValidDate(sp?.period_start)
    ? sp!.period_start!
    : isValidDate(sp?.from)
    ? sp!.from!
    : undefined;
  const endParam = isValidDate(sp?.period_end)
    ? sp!.period_end!
    : isValidDate(sp?.to)
    ? sp!.to!
    : undefined;

  // A pair of explicit dates with no preset means "custom" — same rule the
  // picker uses when you touch the date inputs.
  const presetRaw = sp?.preset ?? (startParam && endParam ? "custom" : undefined);
  const preset = parsePreset(presetRaw, fallback);
  const compareMode = parseCompare(sp?.compare);

  // Explicit valid dates win over the preset (they only coexist with a custom
  // selection); otherwise resolve the preset against "now".
  const range: Range =
    startParam && endParam
      ? { start: startParam, end: endParam }
      : resolvePreset(preset, now, { start: startParam, end: endParam });

  const compareRange = resolveCompare(range, compareMode);
  const brandId = sp?.brand_id && sp.brand_id !== "shop" ? sp.brand_id : null;

  const rangeLabel =
    preset === "custom" ? `${range.start} → ${range.end}` : PRESET_LABELS[preset];

  return {
    preset,
    compareMode,
    brandId,
    range,
    compareRange,
    rangeLabel,
    compareLabel: COMPARE_DELTA_LABEL[compareMode],
    controlProps: {
      preset,
      compare: compareMode,
      brandId,
      periodStart: startParam ?? range.start,
      periodEnd: endParam ?? range.end,
      resolvedStart: range.start,
      resolvedEnd: range.end,
    },
  };
}
