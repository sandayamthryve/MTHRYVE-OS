import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import {
  PageHeader,
  SectionCard,
  StatTile,
  TableShell,
  Badge,
  rowClass,
} from "@/components/ui";
import { AttainmentMeter } from "@/components/contracts/AttainmentMeter";
import { ScanDeliveryRiskButton } from "@/components/contracts/ScanDeliveryRiskButton";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadContractsData, buildScopeAttainment } from "@/lib/contracts/data";
import { deliveryRisk, riskSortValue, type ScopeAttainment } from "@/lib/metrics/contracts";
import { peso, intOrDash } from "@/lib/metrics/format";
import {
  DELIVERABLE_LABEL,
  DELIVERABLE_TONE,
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABEL,
  contractStatusTone,
  formatDate,
} from "@/lib/contracts/display";
import { createContract } from "./actions";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// Reports-vs-Contract v2 — the all-department transparency board.
//
// Every authenticated user sees, per client, the committed scope of work and its
// LIVE attainment (actual vs target over the contract window, on-track / behind).
// Money columns appear only when contract_financials is readable to the caller —
// RLS decides that, and we simply omit them otherwise. Up top, the org delivery
// scorecard ranks clients by how much of their scope is behind. Real numbers
// only: an unmeasurable item reads "no target"/"no data", never a fabricated 0.

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

export default async function ContractsPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const profile = await requireModule("/contracts");
  const canManage = ["ceo", "coo", "department_head"].includes(profile.role);
  const isLeadership = profile.role === "ceo" || profile.role === "coo";
  const supabase = createServerSupabaseClient();
  const archived = searchParams?.archived === "1";

  const data = await loadContractsData(supabase, { archived });
  const brandName = (id: string | null) => data.brands.find((b) => b.id === id)?.name ?? null;
  const deptName = (id: string | null) => data.departments.find((d) => d.id === id)?.name ?? null;

  // Attainment for every scope item, grouped by contract.
  const allAttainment = buildScopeAttainment(data, data.scopeItems);
  const byContract = new Map<string, ScopeAttainment[]>();
  for (const sa of allAttainment) {
    const arr = byContract.get(sa.item.contract_id) ?? [];
    arr.push(sa);
    byContract.set(sa.item.contract_id, arr);
  }

  // Org delivery scorecard: risk per contract, riskiest first.
  const scorecard = data.contracts
    .map((c) => ({ contract: c, risk: deliveryRisk(byContract.get(c.id) ?? []) }))
    .sort((a, b) => riskSortValue(b.risk) - riskSortValue(a.risk));

  const orgOnTrack = scorecard.reduce((n, r) => n + r.risk.onTrack, 0);
  const orgBehind = scorecard.reduce((n, r) => n + r.risk.behind, 0);
  const contractsAtRisk = scorecard.filter((r) => r.risk.behind > 0).length;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Client Delivery"]} profile={profile}>
      <PageHeader
        title="Client Delivery"
        subtitle="Reports vs Contract — every client's committed scope of work and its live attainment. Money is shown only where you're cleared to see it."
        action={
          <div className="flex flex-wrap items-start gap-2">
            {isLeadership && <ScanDeliveryRiskButton />}
            <Link
              href="/contracts/mine"
              className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink"
            >
              My delivery →
            </Link>
          </div>
        }
      />

      {/* ── Org scorecard summary ─────────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Contracts" value={data.contracts.length} hint="active client commitments" />
        <StatTile label="Scope on track" value={orgOnTrack} valueClassName="text-teal-400" />
        <StatTile label="Scope behind" value={orgBehind} valueClassName={orgBehind > 0 ? "text-red-400" : "text-ink"} />
        <StatTile
          label="Clients at risk"
          value={contractsAtRisk}
          valueClassName={contractsAtRisk > 0 ? "text-amber-400" : "text-ink"}
          hint="≥ 1 deliverable behind"
        />
      </div>

      {/* ── Delivery scorecard (ranked by risk) ───────────────────────────────── */}
      <section className="mb-10">
        <h2 className="mb-1 text-lg font-semibold text-ink">Delivery scorecard</h2>
        <p className="mb-4 text-sm text-ink-muted">
          Clients ranked by delivery risk — how many committed deliverables are behind pace across their scope of work.
        </p>
        {scorecard.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">
            No client contracts on file yet.
          </p>
        ) : (
          <TableShell columns={["Client", "Brand", "Period", "On track", "Behind", "Unmeasured", "Risk"]}>
            {scorecard.map(({ contract: c, risk }) => (
              <tr key={c.id} className={rowClass}>
                <td className="p-3">
                  <Link href={`/contracts/${c.id}`} className="text-ink hover:text-teal-300">
                    {c.client_name ?? "Untitled client"}
                  </Link>
                </td>
                <td className="p-3 text-ink-muted">{brandName(c.brand_id) ?? "—"}</td>
                <td className="p-3 font-mono text-[11px] text-ink-dim">
                  {formatDate(c.period_start)} – {formatDate(c.period_end)}
                </td>
                <td className="p-3 font-mono text-teal-300">{risk.onTrack}</td>
                <td className="p-3 font-mono text-red-300">{risk.behind}</td>
                <td className="p-3 font-mono text-ink-dim">{risk.unmeasured}</td>
                <td className="p-3">
                  {risk.measured === 0 ? (
                    <Badge tone="muted">No data</Badge>
                  ) : risk.behind === 0 ? (
                    <Badge tone="teal">On track</Badge>
                  ) : (
                    <Badge tone={risk.behindPct != null && risk.behindPct >= 50 ? "red" : "amber"}>
                      {Math.round(risk.behindPct ?? 0)}% behind
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </section>

      {/* ── Per-client transparency ───────────────────────────────────────────── */}
      <section className="mb-10">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Client transparency</h2>
          <ArchivedToggle basePath="/contracts" archived={archived} />
        </div>
        <p className="mb-4 text-sm text-ink-muted">
          Each client's scope of work with live attainment. Open a client to edit scope, enter financials or deploy to departments.
        </p>
        {data.contracts.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">
            {archived ? "No archived contracts." : `No client contracts yet.${canManage ? " Add the first one below." : ""}`}
          </p>
        ) : (
          <div className="space-y-4">
            {data.contracts.map((c) => {
              const items = byContract.get(c.id) ?? [];
              const showMoney = data.financialsByContract.has(c.id);
              const fin = data.financialsByContract.get(c.id);
              return (
                <SectionCard
                  key={c.id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <Link href={`/contracts/${c.id}`} className="hover:text-teal-300">
                        {c.client_name ?? "Untitled client"}
                      </Link>
                      {brandName(c.brand_id) && (
                        <span className="font-normal text-ink-dim">· {brandName(c.brand_id)}</span>
                      )}
                      <Badge tone={contractStatusTone(c.status)}>
                        {CONTRACT_STATUS_LABEL[c.status] ?? c.status}
                      </Badge>
                    </span>
                  }
                  action={
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/contracts/${c.id}`}
                        className="rounded-md bg-charcoal-800 px-2.5 py-1 text-[11px] text-ink-muted hover:bg-charcoal-700 hover:text-ink"
                      >
                        Open
                      </Link>
                      <RowActions {...rowActionProps("client_contracts", c as unknown as Record<string, unknown>, profile)} />
                    </div>
                  }
                >
                  {/* Delivery commitments (money only when readable). */}
                  <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-ink-muted">
                    <span>
                      Period{" "}
                      <span className="text-ink-dim">
                        {formatDate(c.period_start)} – {formatDate(c.period_end)}
                      </span>
                    </span>
                    <span>
                      GMV target{" "}
                      <span className="text-ink">
                        {c.monthly_gmv_target != null ? peso(Number(c.monthly_gmv_target)) : "—"}
                      </span>
                      /mo
                    </span>
                    <span>
                      Content target <span className="text-ink">{intOrDash(c.monthly_content_target)}</span>/mo
                    </span>
                    {showMoney && fin && (
                      <>
                        <span>
                          Fee <span className="text-gold-300">{fin.monthly_fee != null ? peso(Number(fin.monthly_fee)) : "—"}</span>/mo
                        </span>
                        <span>
                          Ad budget <span className="text-gold-300">{fin.monthly_ad_budget != null ? peso(Number(fin.monthly_ad_budget)) : "—"}</span>/mo
                        </span>
                        <span>
                          Margin <span className="text-gold-300">{fin.gross_margin_pct != null ? `${fin.gross_margin_pct}%` : "—"}</span>
                        </span>
                      </>
                    )}
                  </div>

                  {items.length === 0 ? (
                    <p className="text-xs text-ink-muted">No scope of work defined yet.</p>
                  ) : (
                    <TableShell columns={["Deliverable", "Department", "Brand", "Type", "Attainment"]}>
                      {items.map(({ item, attainment }) => (
                        <tr key={item.id} className={rowClass}>
                          <td className="p-3">
                            <span className="text-ink">{item.title}</span>
                            {item.project_id && (
                              <Link
                                href="/projects"
                                className="ml-2 font-mono text-[10px] text-teal-300 hover:underline"
                              >
                                ▸ project
                              </Link>
                            )}
                          </td>
                          <td className="p-3 text-ink-muted">{deptName(item.department_id) ?? "—"}</td>
                          <td className="p-3 text-ink-muted">{brandName(item.brand_id) ?? "—"}</td>
                          <td className="p-3">
                            <Badge tone={DELIVERABLE_TONE[attainment.deliverableType]}>
                              {DELIVERABLE_LABEL[attainment.deliverableType]}
                            </Badge>
                          </td>
                          <td className="p-3 min-w-[220px]">
                            <AttainmentMeter attainment={attainment} showMoney={showMoney} />
                          </td>
                        </tr>
                      ))}
                    </TableShell>
                  )}
                </SectionCard>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Add a contract (writers) ──────────────────────────────────────────── */}
      {canManage && !archived && (
        <SectionCard title="Set up a client contract" className="mb-8">
          <p className="mb-3 text-xs text-ink-muted">
            The delivery commitment header. Scope of work, financials and deploy-to-departments live on the contract page once it exists.
            Deliverables take one per line (<span className="font-mono text-ink">label</span> or <span className="font-mono text-ink">label: detail</span>).
          </p>
          <form action={createContract} className="grid gap-3 sm:grid-cols-3">
            <input name="client_name" required placeholder="Client name" className={`${inputCls} sm:col-span-2`} />
            <select name="brand_id" defaultValue="" className={inputCls}>
              <option value="">Brand… (optional)</option>
              {data.brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Period start
              <input type="date" name="period_start" className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Period end
              <input type="date" name="period_end" className={`${inputCls} mt-1 w-full`} />
            </label>
            <select name="status" defaultValue="active" className={inputCls}>
              {CONTRACT_STATUSES.map((s) => (
                <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
              ))}
            </select>
            <input name="monthly_gmv_target" type="number" step="any" placeholder="Monthly GMV target" className={inputCls} />
            <input name="monthly_content_target" type="number" placeholder="Monthly content target" className={inputCls} />
            <input name="notes" placeholder="Notes (optional)" className={inputCls} />
            <textarea
              name="deliverables"
              placeholder={"Deliverables, one per line\ne.g. 20 TikTok videos: monthly\nWeekly live sessions"}
              rows={3}
              className={`${inputCls} sm:col-span-3`}
            />
            <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-3">
              Create contract
            </button>
          </form>
        </SectionCard>
      )}
    </AppShell>
  );
}
