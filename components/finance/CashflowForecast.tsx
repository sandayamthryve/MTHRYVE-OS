import { Badge, StatTile } from "@/components/ui";
import { peso } from "@/lib/metrics/format";
import type { CashForecast } from "@/lib/finance/forecast";

// Presentational cash-flow forecast: the projected-balance line over the horizon,
// the current runway headline ("cash positive through {date}" or "deficit in {N}
// days"), and the drivers behind it. Every value is real data handed down from
// the page — nothing is computed here. The honest "no cash position set" state is
// the page's responsibility (this only renders once an anchor exists).

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function shortDate(dateStr: string): string {
  const m = Number(dateStr.slice(5, 7)) - 1;
  const d = Number(dateStr.slice(8, 10));
  return SHORT_MONTHS[m] != null ? `${SHORT_MONTHS[m]} ${d}` : dateStr;
}

function signedPeso(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? "−" : "+"}${peso(Math.abs(r))}`;
}

// SVG viewBox geometry. preserveAspectRatio="none" stretches the plot to the
// card width; vector-effect keeps strokes crisp under that stretch.
const W = 760;
const H = 200;
const PAD_L = 6;
const PAD_R = 6;
const PAD_T = 14;
const PAD_B = 18;

export function CashflowForecast({ forecast }: { forecast: CashForecast }) {
  const pts = forecast.points;
  const buffer = forecast.drivers.safetyBuffer;
  const deficit = forecast.deficitDate != null;
  const accent = deficit ? "#f87171" : "#2dd4bf"; // red-400 / teal-400
  const accentFill = deficit ? "rgba(248,113,113,0.12)" : "rgba(45,212,191,0.12)";

  // Y range across the projection, the buffer line and zero, with headroom.
  const balances = pts.map((p) => p.balance);
  let yMin = Math.min(buffer, 0, ...balances);
  let yMax = Math.max(buffer, ...balances);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad;
  yMax += pad;

  const n = pts.length;
  const x = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD_L - PAD_R));
  const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD_T - PAD_B);

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.balance).toFixed(1)}`).join(" ");
  const baseY = y(yMin).toFixed(1);
  const areaPath = `${linePath} L ${x(n - 1).toFixed(1)} ${baseY} L ${x(0).toFixed(1)} ${baseY} Z`;
  const bufferY = y(buffer).toFixed(1);

  const deficitIdx = deficit ? pts.findIndex((p) => p.date === forecast.deficitDate) : -1;
  const d = forecast.drivers;

  return (
    <div>
      {/* Runway headline */}
      <div
        className={`mb-4 rounded-lg border p-3 ${
          deficit ? "border-red-500/30 bg-red-500/5" : "border-teal-500/30 bg-teal-500/5"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-sm font-semibold ${deficit ? "text-red-300" : "text-teal-300"}`}>
            {deficit
              ? `Cash deficit projected in ${forecast.runwayDays} day${forecast.runwayDays === 1 ? "" : "s"} — ${shortDate(
                  forecast.deficitDate as string
                )}`
              : `Cash positive through ${shortDate(pts[pts.length - 1].date)}`}
          </p>
          <Badge tone={deficit ? "red" : "teal"}>
            {deficit
              ? `Shortfall ${peso(Math.round(forecast.projectedShortfall ?? 0))}`
              : `Low ${peso(Math.round(forecast.minBalance))}`}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-ink-muted">
          {peso(Math.round(forecast.startBalance))} on hand as of {shortDate(d.asOfDate)}
          {d.account ? ` · ${d.account}` : ""} · {d.horizonDays}-day projection
          {buffer > 0 ? ` · safety buffer ${peso(Math.round(buffer))}` : ""}.
        </p>
      </div>

      {/* Projected-balance line */}
      <div className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-44 w-full" role="img" aria-label="Projected cash balance over the horizon">
          {/* buffer / zero baseline */}
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={bufferY}
            y2={bufferY}
            stroke="#6b7280"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          {/* area + line */}
          <path d={areaPath} fill={accentFill} stroke="none" />
          <path d={linePath} fill="none" stroke={accent} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {/* deficit marker */}
          {deficitIdx >= 0 && (
            <>
              <line
                x1={x(deficitIdx)}
                x2={x(deficitIdx)}
                y1={PAD_T}
                y2={H - PAD_B}
                stroke="#f87171"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={x(deficitIdx)} cy={y(pts[deficitIdx].balance)} r={3.5} fill="#f87171" />
            </>
          )}
          {/* start / anchor point */}
          <circle cx={x(0)} cy={y(pts[0].balance)} r={3} fill={accent} />
        </svg>
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-ink-dim">
          <span>{shortDate(pts[0].date)}</span>
          <span className="text-ink-muted">{buffer > 0 ? `buffer ${peso(Math.round(buffer))}` : "zero line"}</span>
          <span>{shortDate(pts[pts.length - 1].date)}</span>
        </div>
      </div>

      {/* Drivers */}
      <p className="mb-2 mt-4 font-mono text-[10px] uppercase tracking-wider text-ink-dim">Drivers</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile
          label="Avg daily net"
          value={signedPeso(d.avgDailyNet)}
          valueClassName={d.avgDailyNet < 0 ? "text-red-300" : "text-teal-300"}
          hint="average across the horizon"
        />
        <StatTile
          label="Next payroll"
          value={d.nextPayroll ? peso(Math.round(d.nextPayroll.total)) : "—"}
          hint={d.nextPayroll ? shortDate(d.nextPayroll.date) : "none in horizon"}
        />
        <StatTile
          label="Retainer inflows"
          value={peso(Math.round(d.retainerMonthly))}
          hint="recurring / month"
        />
        <StatTile
          label="Settlement run-rate"
          value={`${peso(Math.round(d.settlementRunRateDaily))}/d`}
          hint="trailing settlements"
        />
        <StatTile
          label="Expense run-rate"
          value={`${peso(Math.round(d.expenseRunRateDaily))}/d`}
          hint="trailing-90d outflows"
        />
        <StatTile
          label="Upcoming payroll"
          value={peso(Math.round(d.upcomingPayrollTotal))}
          hint="total in horizon"
        />
      </div>
    </div>
  );
}
