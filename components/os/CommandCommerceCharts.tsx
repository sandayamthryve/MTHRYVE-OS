"use client";

// components/os/CommandCommerceCharts.tsx — flag-gated, range-scoped GMV-by-Platform
// donut and Revenue Pulse for the Command Center.
//
// These sit under the SAME date-range selector as the Revenue tile and must
// respect it: when NEXT_PUBLIC_USE_SNAPSHOT is on, they read the canonical
// /api/os/snapshot for the CURRENTLY SELECTED range (from tiktok_shop_performance,
// never the stale brand_platform_metrics) and render THAT range's split / weekly
// pulse. Until the snapshot resolves — and on any error — they show the
// server-rendered `fallback` chart, so the panels never regress.
//
// Both reuse the existing presentational charts (components/ceo/charts); we only
// re-shape the snapshot into the charts' prop types. An error boundary guarantees
// a throw degrades to `fallback` rather than taking down the page.

import { Component, type ReactNode } from "react";
import { useSnapshot } from "@/lib/os/useSnapshot";
import { PlatformDonut, RevenuePulseChart } from "@/components/ceo/charts";
import type { PlatformSplit, RevenuePulse, Platform } from "@/lib/ceo/mission-control";

class ChartBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  componentDidCatch(err: unknown): void {
    if (process.env.NODE_ENV !== "production") {
      console.error("[CommandCommerceCharts] render failed; showing fallback", err);
    }
  }
  render(): ReactNode {
    return this.state.crashed ? <>{this.props.fallback}</> : this.props.children;
  }
}

// GMV-by-Platform donut for the selected range. tiktok_shop is the only live sales
// pipe today, so the snapshot carries a single honest slice (shopee/lazada are null
// upstream — never a stale figure).
function SnapshotPlatformDonutInner({ fallback }: { fallback: ReactNode }) {
  const { data, error, loading } = useSnapshot();
  if (loading || error || !data?.platform_split) return <>{fallback}</>;

  const ps = data.platform_split;
  const split: PlatformSplit = {
    slices: ps.slices.map((s) => ({
      platform: s.platform as Platform,
      label: s.label,
      gmv: s.gmv,
      pct: s.pct,
    })),
    totalGmv: ps.total_gmv,
    hasData: ps.has_data,
    currency: ps.currency,
    windowLabel: ps.window_label,
    // Shopee/Lazada have no clean live pipe today (tiktok_shop_performance is the
    // only source); the donut lists them as an honest "not connected" rather than a
    // stale brand_platform_metrics figure or a fabricated 0.
    disconnected: [
      { platform: "shopee" as Platform, label: "Shopee" },
      { platform: "lazada" as Platform, label: "Lazada" },
    ],
  };
  return <PlatformDonut split={split} />;
}

// Revenue Pulse: 12 ISO weeks of TikTok GMV ending at the selected range's end.
function SnapshotRevenuePulseInner({ fallback }: { fallback: ReactNode }) {
  const { data, error, loading } = useSnapshot();
  if (loading || error || !data?.revenue_pulse) return <>{fallback}</>;

  const rp = data.revenue_pulse;
  const pulse: RevenuePulse = {
    points: rp.points.map((p) => ({ isoWeek: p.iso_week, label: p.label, gmv: p.gmv })),
    hasData: rp.has_data,
    currency: rp.currency,
  };
  return <RevenuePulseChart pulse={pulse} />;
}

export function SnapshotPlatformDonut({ fallback }: { fallback: ReactNode }) {
  return (
    <ChartBoundary fallback={fallback}>
      <SnapshotPlatformDonutInner fallback={fallback} />
    </ChartBoundary>
  );
}

export function SnapshotRevenuePulse({ fallback }: { fallback: ReactNode }) {
  return (
    <ChartBoundary fallback={fallback}>
      <SnapshotRevenuePulseInner fallback={fallback} />
    </ChartBoundary>
  );
}
