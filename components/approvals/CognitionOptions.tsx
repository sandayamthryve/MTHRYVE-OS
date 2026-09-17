import { Badge } from "@/components/ui";
import { confidencePct } from "@/lib/actions/types";
import type { CognitionOption } from "@/lib/cognition/types";

// The Cognition Loop's 3-possibility block on an action card. Each option shows
// What / Why / How / Impact, its confidence, and the honest auto-vs-gate task
// split. The option the brief recommends is highlighted (matched by label). This
// is purely presentational — every value is real data drafted by Tony.

function optionIsRecommended(label: string, recommendation: string | null): boolean {
  if (!recommendation || !label) return false;
  return recommendation.toLowerCase().includes(label.toLowerCase());
}

function SplitList({ title, items, tone }: { title: string; items: string[]; tone: "auto" | "gate" }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0 flex-1">
      <p
        className={`mb-1 font-mono text-[10px] uppercase tracking-wider ${
          tone === "auto" ? "text-teal-400" : "text-amber-400"
        }`}
      >
        {title}
      </p>
      <ul className="space-y-0.5">
        {items.map((s, i) => (
          <li key={i} className="text-[11px] text-ink-muted">
            • {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CognitionOptions({
  options,
  recommendation,
}: {
  options: CognitionOption[];
  recommendation: string | null;
}) {
  if (options.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
        Three possibilities Tony weighed
      </p>
      <ul className="space-y-2.5">
        {options.map((o, i) => {
          const recommended = optionIsRecommended(o.label, recommendation);
          return (
            <li
              key={i}
              className={`rounded-md border p-3 ${
                recommended
                  ? "border-teal-500/40 bg-teal-500/5"
                  : "border-charcoal-700/70 bg-charcoal-950/40"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  {String.fromCharCode(65 + i)}. {o.label}
                </p>
                <div className="flex items-center gap-1.5">
                  {recommended && <Badge tone="teal">Recommended</Badge>}
                  <Badge tone="muted">{confidencePct(o.confidence)} confidence</Badge>
                </div>
              </div>
              <dl className="mt-2 grid gap-1.5 text-xs">
                {o.what && (
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                      What
                    </dt>
                    <dd className="text-ink">{o.what}</dd>
                  </div>
                )}
                {o.why && (
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                      Why
                    </dt>
                    <dd className="text-ink-muted">{o.why}</dd>
                  </div>
                )}
                {o.how && (
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                      How
                    </dt>
                    <dd className="text-ink-muted">{o.how}</dd>
                  </div>
                )}
                {o.impact && (
                  <div className="flex gap-2">
                    <dt className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                      Impact
                    </dt>
                    <dd className="text-ink-muted">{o.impact}</dd>
                  </div>
                )}
              </dl>
              {(o.task_split.auto.length > 0 || o.task_split.gate.length > 0) && (
                <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-2 border-t border-charcoal-700/60 pt-2">
                  <SplitList title="Auto · could run unattended" items={o.task_split.auto} tone="auto" />
                  <SplitList title="Gate · needs a human" items={o.task_split.gate} tone="gate" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
