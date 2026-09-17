import { AppShell } from "@/components/layout/AppShell";
import { Badge, PageHeader, StatTile, TableShell, SectionCard, rowClass } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso, pesoOrDash, pctOrDash, ratioOrDash, EMPTY } from "@/lib/metrics/format";
import { parseWindowKey, resolveWindow, type WindowKey } from "@/lib/metrics/windows";
import { computeScoreboard, type PodScore } from "@/lib/vesper/scoreboard";

// Growth Scoreboard — Tony's weekly cockpit. The playbook KPIs computed from
// LIVE data, per pod and org-wide, through the shared scoreboard engine
// (lib/vesper/scoreboard) that the compile_scoreboard executor also uses. Read-
// open to the org. Honest empty states throughout: a KPI that can't be measured
// yet renders an em-dash — never a fabricated zero.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

const WINDOWS: { value: WindowKey; label: string }[] = [
  { value: "mtd", label: "Month-to-date" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "month", label: "This month" },
];

// A concentration-risk tone: the more revenue sits in one client, the more risk.
function concentrationTone(pct: number | null): "teal" | "amber" | "red" | "muted" {
  if (pct == null) return "muted";
  if (pct >= 50) return "red";
  if (pct >= 35) return "amber";
  return "teal";
}

export default async function ScoreboardPage({
  searchParams,
}: {
  searchParams: { window?: string };
}) {
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const windowKey = parseWindowKey(searchParams.window, "mtd");
  const window = resolveWindow(windowKey);
  const board = await computeScoreboard(db, profile.org_id, window);
  const { org, pods } = board;

  const selectCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink";

  return (
    <AppShell breadcrumb={["Mthryve OS", "Growth", "Scoreboard"]} profile={profile}>
      <PageHeader
        title="Growth Scoreboard"
        subtitle="The weekly cockpit — brands, GMV, ROAS, contribution, retention and concentration, per pod and org-wide, from live data."
        action={
          <form action="/scoreboard" method="get" className="flex items-end gap-2">
            <label className="text-[11px] text-ink-muted">
              Window
              <select name="window" defaultValue={windowKey} className={`mt-1 block ${selectCls}`}>
                {WINDOWS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Apply
            </button>
          </form>
        }
      />

      {/* Org-wide KPIs */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Brands under mgmt"
          value={`${org.brandsUnderManagement}`}
          hint={`of ${org.totalBrands} total`}
        />
        <StatTile
          label={`GMV managed · ${org.windowLabel}`}
          value={org.hasGmv ? peso(org.gmv) : EMPTY}
          hint={org.hasGmv ? "live commerce data" : "no GMV data yet"}
        />
        <StatTile
          label="Live ROAS"
          value={ratioOrDash(org.roas)}
          hint={org.roas == null ? "no ad spend/revenue yet" : "ad revenue ÷ spend"}
        />
        <StatTile
          label="Concentration risk"
          value={pctOrDash(org.concentrationPct)}
          valueClassName={
            org.concentrationPct != null && org.concentrationPct >= 50
              ? "text-red-300"
              : org.concentrationPct != null && org.concentrationPct >= 35
              ? "text-amber-300"
              : "text-ink"
          }
          hint={org.topClientName ? `top client: ${org.topClientName}` : "top client's share of GMV"}
        />
        <StatTile
          label="Retention"
          value={pctOrDash(org.retentionPct)}
          hint={
            org.churnedCount == null
              ? "no lifecycle data yet"
              : org.churnedCount === 0
              ? "no churn recorded"
              : `${org.churnedCount} churned`
          }
        />
        <StatTile
          label="Pod contribution"
          value={org.contributionMeasurable ? pesoOrDash(org.agencyRevenue) : EMPTY}
          hint={org.contributionMeasurable ? "agency revenue (fees + take)" : "no cost/fee data yet"}
        />
      </div>

      {/* Per-pod board */}
      {pods.length === 0 ? (
        <SectionCard title="No pods yet">
          <p className="text-sm text-ink-muted">
            Create pods and assign brands on the{" "}
            <a href="/pods" className="text-teal-300 underline hover:text-ink">
              Pods
            </a>{" "}
            tab. The scoreboard rolls up each pod&apos;s brands from live data.
          </p>
        </SectionCard>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Pods</h2>
            {board.unassignedBrandCount > 0 && (
              <span className="text-[11px] text-ink-dim">
                {board.unassignedBrandCount} brand{board.unassignedBrandCount === 1 ? "" : "s"} not yet in a pod
              </span>
            )}
          </div>
          <TableShell
            columns={["Pod", "Lead", "Brands", "GMV managed", "ROAS", "Contribution", "Concentration"]}
          >
            {pods.map((p) => (
              <PodRow key={p.podId} pod={p} />
            ))}
          </TableShell>
          <p className="mt-3 text-[11px] text-ink-dim">
            Contribution % needs client cost/fee data (brand finance); pods without it show{" "}
            <span className="font-mono">—</span>. Nothing here is fabricated — unmeasurable KPIs are honest em-dashes.
          </p>
        </>
      )}
    </AppShell>
  );
}

function PodRow({ pod }: { pod: PodScore }) {
  return (
    <tr className={rowClass}>
      <td className="p-3 align-top">
        <div className="flex items-center gap-2">
          <span className="text-ink">{pod.name}</span>
          {pod.status !== "active" && <Badge tone="muted">{pod.status}</Badge>}
        </div>
        {pod.brandNames.length > 0 && (
          <div className="mt-0.5 max-w-[16rem] truncate font-mono text-[10px] text-ink-dim" title={pod.brandNames.join(", ")}>
            {pod.brandNames.join(" · ")}
          </div>
        )}
      </td>
      <td className="p-3 align-top text-ink-muted">{pod.leadName ?? EMPTY}</td>
      <td className="p-3 align-top font-mono text-ink">
        {pod.brandCount}
        {pod.targetBrands != null ? <span className="text-ink-dim">/{pod.targetBrands}</span> : null}
      </td>
      <td className="p-3 align-top font-mono text-ink">{pod.hasGmv ? peso(pod.gmv) : EMPTY}</td>
      <td className="p-3 align-top font-mono text-ink">{ratioOrDash(pod.roas)}</td>
      <td className="p-3 align-top font-mono text-ink">{pctOrDash(pod.contributionPct)}</td>
      <td className="p-3 align-top">
        {pod.concentrationPct == null ? (
          <span className="font-mono text-ink-dim">{EMPTY}</span>
        ) : (
          <Badge tone={concentrationTone(pod.concentrationPct)}>{pctOrDash(pod.concentrationPct)}</Badge>
        )}
      </td>
    </tr>
  );
}
