import type { ReactNode } from "react";
import { StatTile, HelpHint } from "@/components/ui";
import { pesoCompact, pesoOrDash, EMPTY } from "@/lib/metrics/format";

// Pod P&L — the finance strip that sits on the Pods page for leadership (ceo/coo)
// only. It reads the archived-aware `pod_pnl` view. The honesty rule is baked in:
// direct labor and net contribution are always blank ("—") because payroll isn't
// tracked in the OS yet, and the contribution figure is always labelled
// "pre-labor" so it can never be mistaken for a net margin.

export interface PodPnl {
  retainerMonthly: number | null;
  gmvSynced: number | null;
  takeRevenue: number | null;
  revenueTotal: number | null;
  grossPreLabor: number | null;
  directLabor: number | null; // always null — payroll not tracked
  netContribution: number | null; // always null — payroll not tracked
}

// Roll a set of pod rows into one org-wide summary. A figure that is null in
// every pod stays null (renders "—"); otherwise nulls count as zero so one
// unsynced pod doesn't blank the whole total. Direct labor and net contribution
// are null in every row by construction, so they stay honestly blank.
export function sumPnl(rows: PodPnl[]): PodPnl {
  const sum = (pick: (p: PodPnl) => number | null): number | null => {
    let acc: number | null = null;
    for (const r of rows) {
      const v = pick(r);
      if (v == null) continue;
      acc = (acc ?? 0) + v;
    }
    return acc;
  };
  return {
    retainerMonthly: sum((p) => p.retainerMonthly),
    gmvSynced: sum((p) => p.gmvSynced),
    takeRevenue: sum((p) => p.takeRevenue),
    revenueTotal: sum((p) => p.revenueTotal),
    grossPreLabor: sum((p) => p.grossPreLabor),
    directLabor: sum((p) => p.directLabor),
    netContribution: sum((p) => p.netContribution),
  };
}

// Compact peso for the tight per-card strip; full peso for the big summary tiles.
function compact(n: number | null | undefined): string {
  return n == null ? EMPTY : pesoCompact(Number(n));
}

// The top summary row across every visible pod. Full-precision StatTiles.
export function PodPnlSummary({ total, podCount }: { total: PodPnl; podCount: number }) {
  return (
    <section aria-label="Pod P&L summary" className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">
          Pod P&amp;L
          <span className="ml-2 font-normal text-ink-muted">
            across {podCount} pod{podCount === 1 ? "" : "s"} · leadership only
          </span>
        </h2>
        <HelpHint id="money.podPnl.timeframe" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Retainer / mo" value={pesoOrDash(total.retainerMonthly)} hint="Monthly" />
        <StatTile label="GMV (synced)" value={pesoOrDash(total.gmvSynced)} hint="Synced-to-date" />
        <StatTile label="Take rev" value={pesoOrDash(total.takeRevenue)} hint="On GMV" />
        <StatTile label="Revenue total" value={pesoOrDash(total.revenueTotal)} hint="Retainer + take" />
        <StatTile
          label="Gross contribution (pre-labor)"
          value={pesoOrDash(total.grossPreLabor)}
          valueClassName="text-teal-300"
          hint="Before direct labor"
        />
      </div>
      <p className="text-[11px] text-ink-muted">
        Net contribution and direct labor read <span className="font-mono text-ink-dim">{EMPTY}</span>{" "}
        — payroll isn&apos;t tracked in the OS, so every figure here is gross of labor.
      </p>
    </section>
  );
}

function Figure({
  label,
  value,
  tone = "text-ink",
}: {
  label: string;
  value: ReactNode;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate font-mono text-[9px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className={`font-mono text-sm font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

// The per-card P&L strip. Compact figures + an honest "—" footer for the two
// payroll-dependent fields the view can't yet fill.
export function PodPnlStrip({ pnl }: { pnl: PodPnl }) {
  return (
    <div className="mb-3 rounded-lg border border-charcoal-700/60 bg-charcoal-950/60 p-3">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
        <Figure label="Retainer / mo" value={compact(pnl.retainerMonthly)} />
        <Figure label="GMV (synced)" value={compact(pnl.gmvSynced)} />
        <Figure label="Take rev" value={compact(pnl.takeRevenue)} />
        <Figure label="Revenue total" value={compact(pnl.revenueTotal)} />
        <Figure
          label="Gross contrib (pre-labor)"
          value={compact(pnl.grossPreLabor)}
          tone="text-teal-300"
        />
      </div>
      <p className="mt-2 border-t border-charcoal-700/40 pt-2 font-mono text-[9px] uppercase tracking-wider text-ink-dim">
        Direct labor {EMPTY} · Net contribution {EMPTY}
        <span className="ml-1 normal-case tracking-normal text-ink-muted">(payroll not tracked)</span>
      </p>
    </div>
  );
}
