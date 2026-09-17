"use client";

// components/os/CommandRevenueValue.tsx — flag-gated value + caption for the
// Command Center Revenue KPI, scoped to the SELECTED range.
//
// This is the surface wired to the canonical snapshot, and it is OFF by default.
// The server passes the EXISTING server-computed value/caption as `fallback`; the
// page only mounts these when NEXT_PUBLIC_USE_SNAPSHOT is "true". Even then they
// render `fallback` until the snapshot resolves, and fall back to it on any error
// — so the tile never regresses.
//
// RANGE-CORRECT: the value is company.gmv for the CURRENTLY SELECTED range (the
// provider forwards the page's date-range params to /api/os/snapshot), so Today /
// Yesterday / 7d / 30d / MTD / QTD / YTD each show THAT range's GMV — never a
// single MTD figure on every tab. A range with no rows renders "—" plus
// "No data for this range" and the data-freshness "as of <max stat_date>" — it
// NEVER falls back to MTD or another range's number.
//
// NEVER-CRASH CONTRACT: these tiles must degrade to `fallback`, never throw. Two
// layers enforce that:
//   1. The inner render guards every state — loading / error / 401 / null data /
//      a data object missing `company` — and only formats a genuine number,
//      reading through optional chaining so no dereference can throw.
//   2. An error boundary wraps the inner render, so even an unforeseen throw is
//      caught and the tile shows the server-rendered `fallback`.

import { Component, type ReactNode } from "react";
import { useSnapshot } from "@/lib/os/useSnapshot";
import { pesoCompact, EMPTY } from "@/lib/metrics/format";

interface ValueProps {
  fallback: string;
  currency?: string;
}

// The live value. Guarded so it renders `fallback` for every non-ready state and
// only ever formats a real number (or the honest "—" for an empty range).
function CommandRevenueValueInner({ fallback, currency = "PHP" }: ValueProps) {
  const { data, error, loading } = useSnapshot();

  // While the snapshot is in flight, on any error (network / 500 / 401 / malformed
  // body), or before a well-formed snapshot with a `company` block has landed,
  // show the server-rendered value — the tile is never worse than today.
  if (loading || error || !data?.company) return <>{fallback}</>;

  // `company` is guaranteed present here; the field itself may still be an honest
  // null (no commerce rows in the range) → render "—". Optional chaining keeps this
  // read from ever throwing even if the runtime shape drifts.
  const gmv = data.company?.gmv;
  return <>{gmv == null ? EMPTY : pesoCompact(gmv, currency)}</>;
}

interface CaptionProps {
  fallback: ReactNode;
}

// The live caption. Shows the range the number belongs to (so label + number can
// never disagree) and the data-freshness stamp; for an empty range it says so
// explicitly instead of hinting at another window's figure.
function CommandRevenueCaptionInner({ fallback }: CaptionProps) {
  const { data, error, loading } = useSnapshot();
  if (loading || error || !data?.company) return <>{fallback}</>;

  const gmv = data.company?.gmv;
  const rangeLabel = data.range?.label ?? "";
  const asOf = data.freshness?.as_of_label ?? null;
  const isStale = data.freshness?.is_stale ?? false;

  // Empty range: honest "no data" + the freshness stamp so the user sees WHY
  // (e.g. Today is empty because the latest live day is "as of Jul 27").
  if (gmv == null) {
    return (
      <>
        <span>No data for this range</span>
        {asOf ? (
          <span className="mt-0.5 block text-[10px] text-ink-dim">as of {asOf}</span>
        ) : null}
      </>
    );
  }

  // Has data: name the range the figure covers, plus a freshness note when the
  // latest live day trails today (so a partial "Today"/"7d" is never mistaken for
  // final).
  return (
    <>
      <span>GMV managed · {rangeLabel}</span>
      {isStale && asOf ? (
        <span className="mt-0.5 block text-[10px] text-ink-dim">as of {asOf}</span>
      ) : null}
    </>
  );
}

// Last-resort safety net: if anything inside throws during render, degrade to the
// server value instead of surfacing Next's "Application error" for the whole page.
class RevenueBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(err: unknown): void {
    if (process.env.NODE_ENV !== "production") {
      // Diagnostic only — the UI still degrades gracefully to `fallback`.
      console.error("[CommandRevenue] render failed; showing fallback", err);
    }
  }

  render(): ReactNode {
    return this.state.crashed ? <>{this.props.fallback}</> : this.props.children;
  }
}

export function CommandRevenueValue(props: ValueProps) {
  return (
    <RevenueBoundary fallback={props.fallback}>
      <CommandRevenueValueInner {...props} />
    </RevenueBoundary>
  );
}

export function CommandRevenueCaption(props: CaptionProps) {
  return (
    <RevenueBoundary fallback={props.fallback}>
      <CommandRevenueCaptionInner {...props} />
    </RevenueBoundary>
  );
}
