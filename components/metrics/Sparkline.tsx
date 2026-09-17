// A dependency-free trend sparkline, drawn only when the caller passes >= 2
// points (fewer than two periods of history can't show a trend, so the caller
// omits it). Server-safe — no hooks, no client APIs.
export function Sparkline({
  points,
  stroke = "#4BC0B8",
  className = "mt-2 h-6 w-full opacity-90",
}: {
  points: number[];
  stroke?: string;
  className?: string;
}) {
  if (points.length < 2) return null;
  const W = 88;
  const H = 26;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className}>
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.75" />
    </svg>
  );
}
