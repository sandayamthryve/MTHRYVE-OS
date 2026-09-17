// components/ceo/charts.tsx — the inline-SVG chart primitives for CEO Mission
// Control. No chart library: these render server-side as plain SVG in the
// dark/teal "Obsidian" OS theme, matching the existing MetricTile sparkline
// idiom (zero client JS, zero bundle cost). Every component is PURE presentation
// — it draws exactly the numbers handed to it and shows an honest empty state
// when there's nothing to plot; it never invents a value.
//
// Design-system tokens used (from tailwind.config.ts):
//   teal   #4BC0B8 / #5FD8CF   green #6BC98A   gold #E0BD6E   dim #63727A
// Categorical charts assign a FIXED colour per entity (never by rank) and always
// carry direct labels + a legend, so identity never rests on colour alone.

import { peso, pesoCompact, int, EMPTY } from "@/lib/metrics/format";
import type {
  RevenuePulse,
  PlatformSplit,
  DeptHealth,
  WorkflowActivity,
  Flywheel,
  Platform,
} from "@/lib/ceo/mission-control";

const TEAL = "#4BC0B8";
const TEAL_BRIGHT = "#5FD8CF";
const TEAL_DEEP = "#2FA8A0"; // teal-500 — the deep end of teal→cyan gradients
const GREEN = "#6BC98A";
const GREEN_DEEP = "#4CAF6D"; // green-500
const GOLD = "#E0BD6E";
const GOLD_DEEP = "#D4A94B"; // gold-500
const DIM = "#63727A";
const TRACK = "#202A2F"; // charcoal-800

// Fixed platform → colour map (colour follows the entity, not its share).
const PLATFORM_COLOR: Record<Platform, string> = {
  tiktok_shop: TEAL,
  shopee: GOLD,
  lazada: GREEN,
  other: DIM,
  meta_ads: TEAL_BRIGHT,
  tiktok_ads: GREEN,
  google_ads: GOLD,
};

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[8rem] items-center justify-center rounded-md border border-dashed border-charcoal-700 bg-charcoal-950/40 px-4 py-6 text-center text-xs text-ink-muted">
      {children}
    </div>
  );
}

// ── Ring gauge (Business Health) ──────────────────────────────────────────────

export function RingGauge({
  value,
  color = TEAL,
  size = 132,
  stroke = 12,
  centerLabel,
  centerSub,
}: {
  value: number | null; // 0..100 or null
  color?: string;
  size?: number;
  stroke?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.min(100, Math.max(0, value));
  const dash = (pct / 100) * c;
  const glowId = `ringGlow-${size}-${stroke}`;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0">
      <defs>
        <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="0" stdDeviation={stroke * 0.28} floodColor={color} floodOpacity="0.55" />
        </filter>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TRACK} strokeWidth={stroke} />
      {value != null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={c / 4}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          filter={`url(#${glowId})`}
        />
      )}
      <text
        x="50%"
        y="47%"
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-ink font-display"
        style={{ fontSize: size * 0.26, fontWeight: 700 }}
      >
        {value == null ? EMPTY : String(Math.round(value))}
      </text>
      {centerLabel && (
        <text
          x="50%"
          y="64%"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={DIM}
          style={{ fontSize: size * 0.093, letterSpacing: 0.5 }}
        >
          {centerLabel}
        </text>
      )}
      {centerSub && value != null && (
        <text
          x="50%"
          y="76%"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={DIM}
          style={{ fontSize: size * 0.08 }}
        >
          {centerSub}
        </text>
      )}
    </svg>
  );
}

// ── Sparkline (Revenue MTD tile) ──────────────────────────────────────────────

export function Sparkline({
  points,
  color = GREEN,
  width = 120,
  height = 34,
}: {
  points: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!points || points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / range) * (height - 3) - 1.5;
  const line = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-9 w-full">
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkFill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" />
    </svg>
  );
}

// ── Revenue Pulse (12-week GMV area) ──────────────────────────────────────────

export function RevenuePulseChart({ pulse }: { pulse: RevenuePulse }) {
  if (!pulse.hasData) {
    return (
      <EmptyState>
        No commerce weeks recorded yet — import a week on Platforms or connect a live sync.
      </EmptyState>
    );
  }
  const W = 520;
  const H = 180;
  const padL = 8;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const pts = pulse.points;
  const max = Math.max(...pts.map((p) => p.gmv), 1);
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const x = (i: number) => padL + (pts.length === 1 ? innerW / 2 : (i / (pts.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.gmv).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)} ${padT + innerH} L${x(0).toFixed(1)} ${padT + innerH} Z`;
  const last = pts[pts.length - 1];

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Weekly GMV managed over the last 12 weeks">
        <defs>
          <linearGradient id="pulseFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TEAL_BRIGHT} stopOpacity="0.34" />
            <stop offset="55%" stopColor={TEAL_BRIGHT} stopOpacity="0.08" />
            <stop offset="100%" stopColor={TEAL_BRIGHT} stopOpacity="0" />
          </linearGradient>
          <filter id="pulseGlow" x="-5%" y="-40%" width="110%" height="180%">
            <feDropShadow dx="0" dy="0" stdDeviation="2.4" floodColor={TEAL_BRIGHT} floodOpacity="0.5" />
          </filter>
        </defs>
        {/* faint horizontal gridlines for scale reference */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line
            key={g}
            x1={padL}
            y1={padT + innerH * g}
            x2={W - padR}
            y2={padT + innerH * g}
            stroke={TRACK}
            strokeWidth="1"
            strokeDasharray="2 5"
            opacity="0.5"
          />
        ))}
        {/* baseline */}
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke={TRACK} strokeWidth="1" />
        <path d={area} fill="url(#pulseFill)" />
        <path
          d={line}
          fill="none"
          stroke={TEAL_BRIGHT}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          filter="url(#pulseGlow)"
        />
        {/* dots with native tooltips */}
        {pts.map((p, i) => (
          <circle key={p.isoWeek} cx={x(i)} cy={y(p.gmv)} r={i === pts.length - 1 ? 3.5 : 2} fill={TEAL_BRIGHT}>
            <title>{`${p.label} · ${peso(p.gmv, pulse.currency)}`}</title>
          </circle>
        ))}
        {/* direct label on the latest point */}
        <text x={x(pts.length - 1)} y={Math.max(y(last.gmv) - 8, padT + 8)} textAnchor="end" fill={TEAL_BRIGHT} style={{ fontSize: 11 }} className="font-mono">
          {pesoCompact(last.gmv, pulse.currency)}
        </text>
        {/* first & last week labels */}
        <text x={padL} y={H - 8} fill={DIM} style={{ fontSize: 10 }} className="font-mono">
          {pts[0].label}
        </text>
        <text x={W - padR} y={H - 8} textAnchor="end" fill={DIM} style={{ fontSize: 10 }} className="font-mono">
          {last.label}
        </text>
      </svg>
    </div>
  );
}

// ── GMV by Platform (donut) ───────────────────────────────────────────────────

export function PlatformDonut({ split }: { split: PlatformSplit }) {
  if (!split.hasData) {
    return <EmptyState>No platform GMV this month yet.</EmptyState>;
  }
  const size = 180;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = 2.5; // px surface gap between segments

  let offset = 0;
  const arcs = split.slices.map((s) => {
    const col = PLATFORM_COLOR[s.platform] ?? DIM;
    const len = Math.max(0, (s.pct / 100) * c - gap);
    const arc = (
      <circle
        key={s.platform}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={col}
        strokeWidth={stroke}
        strokeDasharray={`${len} ${c - len}`}
        strokeDashoffset={-offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        filter="url(#donutGlow)"
      >
        <title>{`${s.label} · ${peso(s.gmv, split.currency)} · ${s.pct}%`}</title>
      </circle>
    );
    offset += (s.pct / 100) * c;
    return arc;
  });

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0" role="img" aria-label="GMV share by platform">
        <defs>
          <filter id="donutGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="1.6" floodColor="#000" floodOpacity="0.45" />
          </filter>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TRACK} strokeWidth={stroke} />
        {arcs}
        <text x="50%" y="44%" textAnchor="middle" dominantBaseline="middle" fill={DIM} style={{ fontSize: 10, letterSpacing: 1.2 }}>
          SALES GMV
        </text>
        <text x="50%" y="58%" textAnchor="middle" dominantBaseline="middle" className="fill-ink font-display" style={{ fontSize: 22, fontWeight: 700 }}>
          {pesoCompact(split.totalGmv, split.currency)}
        </text>
      </svg>
      {/* legend + direct values */}
      <ul className="w-full space-y-2">
        {split.slices.map((s) => (
          <li key={s.platform} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[s.platform] ?? DIM }} />
              <span className="truncate text-ink">{s.label}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-ink-muted">
              <span className="text-ink">{s.pct}%</span> · {pesoCompact(s.gmv, split.currency)}
            </span>
          </li>
        ))}
        {/* Sales channels with no live pipe yet: shown as an honest "not connected"
            (never a stale or zeroed figure) so the split reads truthfully. */}
        {(split.disconnected ?? []).map((d) => (
          <li key={d.platform} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed" style={{ borderColor: DIM }} />
              <span className="truncate text-ink-muted">{d.label}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-ink-muted">not connected</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Department Health (horizontal bars) ───────────────────────────────────────

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function DeptHealthBars({ health }: { health: DeptHealth }) {
  if (health.rows.length === 0) {
    return <EmptyState>No departments on record yet.</EmptyState>;
  }
  return (
    <ul className="space-y-3">
      {health.rows.map((d) => {
        const has = d.score != null;
        const v = d.score ?? 0;
        const low = has && v < 60;
        // Teal→cyan gradient is the default; semantic gradients flag the tails
        // (gold when a department slips low, green when it runs hot). Colour
        // still never carries meaning alone — the numeric score sits alongside.
        const fill = low
          ? `linear-gradient(90deg, ${GOLD_DEEP}, ${GOLD})`
          : v >= 80
          ? `linear-gradient(90deg, ${GREEN_DEEP}, ${GREEN})`
          : `linear-gradient(90deg, ${TEAL_DEEP}, ${TEAL_BRIGHT})`;
        const glow = low ? "rgba(212,169,75,.45)" : v >= 80 ? "rgba(76,175,109,.45)" : "rgba(75,192,184,.5)";
        return (
          <li key={d.id} className="flex items-center gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-charcoal-700 bg-charcoal-800 font-display text-[11px] font-semibold text-ink-muted">
              {initials(d.name)}
            </span>
            <span className="w-28 shrink-0 truncate text-sm text-ink" title={d.name}>
              {d.name}
            </span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-charcoal-800 ring-1 ring-inset ring-white/[.03]">
              {has && (
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, v))}%`,
                    background: fill,
                    boxShadow: `0 0 10px -1px ${glow}`,
                  }}
                />
              )}
            </span>
            <span className="w-10 shrink-0 text-right font-mono text-xs text-ink-muted">
              {has ? Math.round(v) : EMPTY}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ── Workflow Activity (grouped bars per day) ──────────────────────────────────

export function WorkflowBars({ workflow }: { workflow: WorkflowActivity }) {
  if (!workflow.hasData) {
    return (
      <EmptyState>
        No automation activity in the last 14 days. Drafted and executed actions from Tony&rsquo;s
        proactive loops appear here.
      </EmptyState>
    );
  }
  const W = 520;
  const H = 170;
  const padT = 10;
  const padB = 24;
  const padL = 8;
  const padR = 8;
  const innerH = H - padT - padB;
  const innerW = W - padL - padR;
  const days = workflow.days;
  const max = Math.max(...days.map((d) => Math.max(d.drafted, d.executed)), 1);
  const slot = innerW / days.length;
  const barW = Math.min(10, slot / 3);
  const y = (v: number) => padT + innerH - (v / max) * innerH;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Actions drafted and executed per day, last 14 days">
        <line x1={padL} y1={padT + innerH} x2={W - padR} y2={padT + innerH} stroke={TRACK} strokeWidth="1" />
        {days.map((d, i) => {
          const cx = padL + i * slot + slot / 2;
          return (
            <g key={d.date}>
              {/* drafted */}
              <rect
                x={cx - barW - 1}
                y={y(d.drafted)}
                width={barW}
                height={padT + innerH - y(d.drafted)}
                rx={2}
                fill={TEAL}
              >
                <title>{`${d.label} · ${d.drafted} drafted`}</title>
              </rect>
              {/* executed */}
              <rect
                x={cx + 1}
                y={y(d.executed)}
                width={barW}
                height={padT + innerH - y(d.executed)}
                rx={2}
                fill={GREEN}
              >
                <title>{`${d.label} · ${d.executed} executed`}</title>
              </rect>
              {(i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) && (
                <text x={cx} y={H - 8} textAnchor="middle" fill={DIM} style={{ fontSize: 10 }} className="font-mono">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-4 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: TEAL }} /> Drafted{" "}
          <span className="font-mono text-ink">{int(workflow.totalDrafted)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: GREEN }} /> Executed{" "}
          <span className="font-mono text-ink">{int(workflow.totalExecuted)}</span>
        </span>
      </div>
    </div>
  );
}

// ── Growth Flywheel (semicircle gauge) ────────────────────────────────────────

export function FlywheelGauge({ flywheel }: { flywheel: Flywheel }) {
  if (!flywheel.hasData) {
    return <EmptyState>No growth pods configured yet.</EmptyState>;
  }
  const W = 240;
  const H = 140;
  const cx = W / 2;
  const cy = 120;
  const r = 96;
  const stroke = 16;
  const actual = flywheel.actualPerPod ?? 0;
  // Scale the gauge to a sensible max: the greater of target and actual, padded.
  const scaleMax = Math.max(flywheel.targetPerPod ?? 0, actual, 1) * 1.25;
  const frac = Math.min(1, actual / scaleMax);

  // Semicircle from 180° (left) to 0° (right).
  const polar = (fraction: number) => {
    const ang = Math.PI - fraction * Math.PI;
    return { x: cx + r * Math.cos(ang), y: cy - r * Math.sin(ang) };
  };
  const arcPath = (fromFrac: number, toFrac: number) => {
    const a = polar(fromFrac);
    const b = polar(toFrac);
    const large = toFrac - fromFrac > 0.5 ? 1 : 0;
    return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };
  const targetFrac =
    flywheel.targetPerPod != null ? Math.min(1, flywheel.targetPerPod / scaleMax) : null;
  const tgt = targetFrac != null ? polar(targetFrac) : null;
  const met = flywheel.targetPerPod != null && actual >= flywheel.targetPerPod;

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Brands per pod versus target">
        <defs>
          <linearGradient id="flywheelArc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={met ? GREEN_DEEP : TEAL_DEEP} />
            <stop offset="100%" stopColor={met ? GREEN : TEAL_BRIGHT} />
          </linearGradient>
          <filter id="flywheelGlow" x="-20%" y="-40%" width="140%" height="180%">
            <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor={met ? GREEN : TEAL_BRIGHT} floodOpacity="0.5" />
          </filter>
        </defs>
        <path d={arcPath(0, 1)} fill="none" stroke={TRACK} strokeWidth={stroke} strokeLinecap="round" />
        <path d={arcPath(0, frac)} fill="none" stroke="url(#flywheelArc)" strokeWidth={stroke} strokeLinecap="round" filter="url(#flywheelGlow)" />
        {tgt && (
          <>
            <line
              x1={cx + (r - stroke) * Math.cos(Math.PI - targetFrac! * Math.PI)}
              y1={cy - (r - stroke) * Math.sin(Math.PI - targetFrac! * Math.PI)}
              x2={cx + (r + stroke / 2) * Math.cos(Math.PI - targetFrac! * Math.PI)}
              y2={cy - (r + stroke / 2) * Math.sin(Math.PI - targetFrac! * Math.PI)}
              stroke={GOLD}
              strokeWidth="2.5"
            />
          </>
        )}
        <text x={cx} y={cy - 26} textAnchor="middle" className="fill-ink font-display" style={{ fontSize: 30, fontWeight: 700 }}>
          {flywheel.actualPerPod ?? EMPTY}
        </text>
        <text x={cx} y={cy - 8} textAnchor="middle" fill={DIM} style={{ fontSize: 11 }}>
          brands / pod
        </text>
      </svg>
      <p className="mt-1 text-xs text-ink-muted">
        {flywheel.brandsUnderManagement} brands across {flywheel.pods} pod{flywheel.pods === 1 ? "" : "s"}
        {flywheel.targetPerPod != null ? (
          <>
            {" · "}
            <span style={{ color: GOLD }}>target {flywheel.targetPerPod}</span>
            {met ? " · met" : ""}
          </>
        ) : (
          " · no target set"
        )}
      </p>
    </div>
  );
}
