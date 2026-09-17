import { Badge } from "@/components/ui";
import type { Attainment } from "@/lib/metrics/contracts";
import {
  flagLabel,
  flagTone,
  formatValue,
  formatAttainmentPct,
} from "@/lib/contracts/display";

// A compact "actual vs target" meter for one scope item's attainment.
//
// The filled bar is actual/target (clamped to 100% for the visual), tinted by
// the verdict; a subtle tick marks how much of the contract window has elapsed,
// so "behind" is legible at a glance — the fill sitting left of the pace tick.
// Money figures are only rendered when `showMoney` is true (the caller passes
// false when contract_financials wasn't readable), in which case a money-typed
// deliverable shows the verdict without exposing amounts.
export function AttainmentMeter({
  attainment,
  showMoney = true,
  className = "",
}: {
  attainment: Attainment;
  showMoney?: boolean;
  className?: string;
}) {
  const a = attainment;
  const moneyHidden = a.isMoney && !showMoney;
  const pct = a.attainmentPct;
  const fill = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const pace = a.expectedPct == null ? null : Math.max(0, Math.min(100, a.expectedPct));

  const barTone =
    a.flag === "on_track"
      ? "bg-teal-500"
      : a.flag === "behind"
      ? "bg-red-500"
      : a.flag === "no_target"
      ? "bg-amber-500/70"
      : "bg-charcoal-600";

  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-ink-muted">
          {moneyHidden ? (
            <span className="text-ink-dim">Financials hidden</span>
          ) : (
            <>
              <span className="text-ink">{formatValue(a.actual, a)}</span>
              <span className="text-ink-dim"> / {formatValue(a.target, a)}</span>
              {a.unit ? <span className="text-ink-dim"> {a.unit}</span> : null}
            </>
          )}
        </span>
        <Badge tone={flagTone(a.flag)}>
          {a.flag === "behind" || a.flag === "on_track"
            ? `${flagLabel(a.flag)} · ${formatAttainmentPct(a)}`
            : flagLabel(a.flag)}
        </Badge>
      </div>
      {!moneyHidden && (a.flag === "on_track" || a.flag === "behind") && (
        <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-charcoal-800">
          <div className={`h-full rounded-full ${barTone}`} style={{ width: `${fill}%` }} />
          {pace != null && (
            <span
              aria-hidden
              title={`${pace}% of window elapsed`}
              className="absolute top-[-2px] h-[10px] w-px bg-ink/70"
              style={{ left: `${pace}%` }}
            />
          )}
        </div>
      )}
      {(a.flag === "no_data" || a.flag === "no_target" || a.flag === "manual") && (
        <p className="mt-1 text-[11px] text-ink-dim">{a.note}</p>
      )}
    </div>
  );
}
