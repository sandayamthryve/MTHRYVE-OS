"use client";

// Filter + sort + week controls for the affiliate performance-standard registry.
// Each change navigates with updated ?week=/?tier=/?std=/?sort= params (the page
// is a server component that reads them and recomputes), so the view is
// shareable and survives refresh. "All" clears a filter.
import { useRouter, usePathname, useSearchParams } from "next/navigation";

export type StandardsQuery = {
  week: "current" | "last";
  tier: string; // "all" or a tier name
  std: string; // "all" | "meets" | "at_risk" | "below" | "ungraded"
  sort: string; // "standard" | "post_rate" | "tier"
};

const SELECT_CLS =
  "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";

export function StandardsControls({
  tiers,
  current,
}: {
  tiers: string[];
  current: StandardsQuery;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function setParam(key: string, value: string, clearValue: string) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === clearValue) next.delete(key);
    else next.set(key, value);
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-ink-muted">
        Week
        <select
          value={current.week}
          onChange={(e) => setParam("week", e.target.value, "current")}
          aria-label="Week"
          className={SELECT_CLS}
        >
          <option value="current">Current week (to-date)</option>
          <option value="last">Last completed week</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-ink-muted">
        Tier
        <select
          value={current.tier}
          onChange={(e) => setParam("tier", e.target.value, "all")}
          aria-label="Filter by tier"
          className={SELECT_CLS}
        >
          <option value="all">All tiers</option>
          {tiers.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
          <option value="untiered">Untiered</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-ink-muted">
        Standard
        <select
          value={current.std}
          onChange={(e) => setParam("std", e.target.value, "all")}
          aria-label="Filter by standard"
          className={SELECT_CLS}
        >
          <option value="all">All</option>
          <option value="meets">Meets standard</option>
          <option value="at_risk">At risk</option>
          <option value="below">Below standard</option>
          <option value="ungraded">Not graded</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-wider text-ink-muted">
        Sort
        <select
          value={current.sort}
          onChange={(e) => setParam("sort", e.target.value, "standard")}
          aria-label="Sort"
          className={SELECT_CLS}
        >
          <option value="standard">Worst standard first</option>
          <option value="post_rate">Lowest post rate first</option>
          <option value="tier">By tier</option>
        </select>
      </label>
    </div>
  );
}
