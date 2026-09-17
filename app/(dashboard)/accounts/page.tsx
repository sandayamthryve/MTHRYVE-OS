import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PageHeader } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  gatherBrandData,
  computeBadge,
  computeFlags,
  type Badge,
} from "@/lib/briefings/account-data";
import { getLatestAccountBriefing, type Solution } from "@/lib/briefings/read";
import { generateAccountBriefing } from "@/lib/briefings/generate";
import { getAccountBriefingFigures } from "@/lib/briefings/exec-figures";
import { StalenessBanner, whenLabel } from "@/components/briefings/StalenessBanner";
import { pesoOrDash, intOrDash } from "@/lib/metrics/format";

// Account Intelligence — per-client truthfulness, challenges, bottlenecks, and an
// AI "3 solutions, 3 steps ahead" briefing. Truthful by design: the badge and the
// red flags are computed in code from real rows (never invented), and the AI is
// refused when the data is too thin to advise on. Data gathering, the badge/flag
// computation, and the generation engine now live in lib/briefings so the same
// logic feeds the reusable <AiBrief> surfaces (Reports, Campaigns).

type NamedRow = { id: string; name: string };

const TONE_CLASS: Record<Badge["tone"], string> = {
  teal: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  muted: "border-charcoal-700 bg-charcoal-800 text-ink-muted",
};

export default async function AccountsPage({ searchParams }: { searchParams: { brand?: string } }) {
  const profile = await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const supabase = createServerSupabaseClient();

  const brandRes = await supabase.from("brands").select("id, name").order("name");
  const brands = (brandRes.data ?? []) as unknown as NamedRow[];
  const selectedId = (searchParams.brand ?? "").trim();
  const selected = brands.find((b) => b.id === selectedId) ?? null;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Account Intelligence"]} profile={profile}>
      <PageHeader
        title="Account Intelligence"
        subtitle="Per-client truthfulness, challenges, bottlenecks, and AI solutions positioned 3 steps ahead. Pick a client to analyze."
      />

      <form action="/accounts" method="get" className="mb-6 flex gap-2">
        <select
          name="brand"
          defaultValue={selectedId}
          className="w-full max-w-sm rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
        >
          <option value="">Select a client…</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
        >
          Analyze
        </button>
      </form>

      {!selected ? (
        <Card className="p-6 text-sm text-ink-muted">
          Pick a client above to see how trustworthy its data is, what&rsquo;s going wrong, and an AI briefing positioned
          3 steps ahead.
        </Card>
      ) : (
        await renderBrand(supabase, selected)
      )}
    </AppShell>
  );
}

async function renderBrand(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  brand: NamedRow
) {
  const data = await gatherBrandData(supabase, brand.id);
  const badge = computeBadge(data);
  const flags = computeFlags(data);

  // PR 8 — the client-facing briefing's headline figures, resolved LIVE at render
  // time from tiktok_shop_performance (never the numbers frozen into the cached
  // summary). nowMs anchors the staleness banner on account_briefings.created_at.
  const nowMs = Date.now();
  const [briefing, figures] = await Promise.all([
    getLatestAccountBriefing(supabase, brand.id),
    getAccountBriefingFigures(supabase, brand.id),
  ]);
  const solutions = (briefing?.solutions ?? []) as Solution[];

  const isLiveSynced = badge.sourceLabel === "Live-synced";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">{brand.name}</h2>
        <Link href={`/brands/${brand.id}`} className="text-xs text-teal-400 hover:text-teal-300">
          Open commerce dashboard →
        </Link>
      </div>

      {/* Truthfulness badge */}
      <Card>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Data truthfulness</p>
        <div className={`inline-flex flex-wrap items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${TONE_CLASS[badge.tone]}`}>
          <span className="font-semibold capitalize">{badge.confidence}</span>
          <span aria-hidden className="opacity-50">·</span>
          <span>{badge.sourceLabel}</span>
          <span aria-hidden className="opacity-50">·</span>
          <span className="font-mono text-xs">{badge.ageText}</span>
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          {isLiveSynced
            ? "Figures are auto-populated from the live TikTok Shop sync — no manual entry needed."
            : "Latest figures are manually entered until this brand's TikTok Shop sync lands a day."}
        </p>
      </Card>

      {/* Challenges + bottlenecks */}
      <Card>
        <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
          Challenges &amp; bottlenecks
        </p>
        {flags.length === 0 ? (
          <p className="text-sm text-ink-muted">No automated red flags on the available data.</p>
        ) : (
          <ul className="space-y-2">
            {flags.map((f, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-ink">
                <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* AI briefing */}
      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">AI briefing — 3 steps ahead</p>
          <form action={generateAccountBriefing}>
            <input type="hidden" name="brand_id" value={brand.id} />
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              {briefing ? "Refresh briefing" : "Generate briefing"}
            </button>
          </form>
        </div>

        {!briefing ? (
          <p className="text-sm text-ink-muted">
            No briefing yet. Generate one to get a truthful assessment and 3 forward-looking solutions.
          </p>
        ) : (
          <div className="space-y-4">
            {/* ── Staleness banner — unmissable once the briefing is >24h old ── */}
            <StalenessBanner
              createdAt={briefing.created_at}
              nowMs={nowMs}
              refresh={
                <form action={generateAccountBriefing}>
                  <input type="hidden" name="brand_id" value={brand.id} />
                  <button
                    type="submit"
                    className="rounded-md bg-amber-400 px-3 py-1.5 text-xs font-bold text-charcoal-950 hover:bg-amber-300"
                  >
                    Refresh
                  </button>
                </form>
              }
            />

            {/* ── Live figures — resolved at RENDER time from tiktok_shop_performance.
                CLIENT-FACING: these NEVER come from the cached summary. Any figure
                that can't be resolved live renders "—", never a stale number, never
                0. Month-to-date; the brief's own scope. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                {
                  label: `GMV · MTD`,
                  value: pesoOrDash(figures.gmvMtd, figures.currency),
                  tone: "text-teal-300",
                },
                {
                  label: "Orders · MTD",
                  value: intOrDash(figures.ordersMtd),
                  tone: "text-ink",
                },
                {
                  label: figures.latestDay ? `GMV · ${figures.latestDay.statDate}` : "GMV · latest day",
                  value: pesoOrDash(figures.latestDay ? figures.latestDay.gmv : null, figures.currency),
                  hint: figures.latestDay ? "latest live day" : "no live day on file",
                  tone: "text-ink",
                },
                {
                  label: `GMV · ${figures.priorMonth}`,
                  value: pesoOrDash(figures.gmvPriorMonth, figures.currency),
                  tone: "text-ink-muted",
                },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-charcoal-700 bg-charcoal-950/50 p-3">
                  <p className="font-mono text-[9px] uppercase tracking-wider text-ink-muted">{c.label}</p>
                  <p className={`mt-0.5 font-mono text-sm ${c.tone}`}>{c.value}</p>
                  {c.hint && <p className="mt-0.5 text-[10px] text-ink-muted">{c.hint}</p>}
                </div>
              ))}
            </div>
            <p className="font-mono text-[10px] text-ink-muted">
              ↑ Live figures · resolved now from TikTok Shop · the briefing below is cached
            </p>

            {briefing.summary && <p className="text-sm leading-relaxed text-ink">{briefing.summary}</p>}

            {solutions.length > 0 && (
              <div className="grid gap-4 lg:grid-cols-3">
                {solutions.map((s, i) => (
                  <div key={i} className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-4">
                    <p className="text-sm font-semibold text-teal-300">{s.solution}</p>
                    {s.why && <p className="mt-1 text-xs italic text-ink-muted">{s.why}</p>}
                    {Array.isArray(s.steps) && s.steps.length > 0 && (
                      <ol className="mt-3 space-y-1.5">
                        {s.steps.map((step, j) => (
                          <li key={j} className="flex items-start gap-2 text-xs text-ink">
                            <span className="font-mono text-teal-400">{j + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className="font-mono text-[10px] text-ink-muted">
              generated by {briefing.model ?? "—"} · {briefing.data_confidence} ·{" "}
              {whenLabel(briefing.created_at)}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
