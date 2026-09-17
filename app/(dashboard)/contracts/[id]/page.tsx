import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { notFound } from "next/navigation";
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
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadContractsData, buildScopeAttainment } from "@/lib/contracts/data";
import { deliveryRisk } from "@/lib/metrics/contracts";
import { peso, intOrDash } from "@/lib/metrics/format";
import {
  DELIVERABLE_LABEL,
  DELIVERABLE_TONE,
  DELIVERABLE_TYPES_LIST,
  SCOPE_STATUSES,
  SCOPE_STATUS_LABEL,
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABEL,
  contractStatusTone,
  formatDate,
} from "@/lib/contracts/display";
import {
  updateContract,
  saveFinancials,
  createScopeItem,
  updateScopeItem,
  deleteScopeItem,
  deployScope,
} from "../actions";

// Contract detail — setup, financials, scope of work, one-click deploy and live
// attainment for a single client contract. Writers (ceo/coo/department_head) can
// edit the header and scope; only ceo/coo can enter financials. RLS is the real
// guard; the page only offers controls a policy would accept.

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";
const fieldCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-xs text-ink";

function deliverablesToText(deliverables: unknown): string {
  if (!Array.isArray(deliverables)) return "";
  return deliverables
    .map((d) => {
      if (d && typeof d === "object" && "label" in d) {
        const label = String((d as { label?: unknown }).label ?? "");
        const detail = (d as { detail?: unknown }).detail;
        return detail ? `${label}: ${detail}` : label;
      }
      return String(d);
    })
    .filter(Boolean)
    .join("\n");
}

export default async function ContractDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { deployed?: string; skipped?: string };
}) {
  const profile = await requireModule("/contracts");
  const canManage = ["ceo", "coo", "department_head"].includes(profile.role);
  const isLeadership = profile.role === "ceo" || profile.role === "coo";
  const supabase = createServerSupabaseClient();

  const data = await loadContractsData(supabase);
  const contract = data.contracts.find((c) => c.id === params.id);
  if (!contract) notFound();

  const brandName = (id: string | null) => data.brands.find((b) => b.id === id)?.name ?? null;
  const deptName = (id: string | null) => data.departments.find((d) => d.id === id)?.name ?? null;
  const projectName = (id: string | null) => data.projects.find((p) => p.id === id)?.name ?? null;

  const items = data.scopeItems.filter((i) => i.contract_id === contract.id);
  const attainment = buildScopeAttainment(data, items);
  const risk = deliveryRisk(attainment);

  const fin = data.financialsByContract.get(contract.id);
  // Financials visible to ceo/coo (who manage them) and to any dept head the RLS
  // select policy returned a row for. Everyone else: hidden entirely.
  const canSeeFinancials = isLeadership || data.financialsByContract.has(contract.id);
  const undeployed = items.filter((i) => !i.project_id).length;

  const deployedCount = Number(searchParams?.deployed ?? "");
  const showDeployBanner = searchParams?.deployed != null && Number.isFinite(deployedCount);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Client Delivery", contract.client_name ?? "Contract"]} profile={profile}>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {contract.client_name ?? "Untitled client"}
            <Badge tone={contractStatusTone(contract.status)}>
              {CONTRACT_STATUS_LABEL[contract.status] ?? contract.status}
            </Badge>
          </span>
        }
        subtitle={
          <>
            {brandName(contract.brand_id) ? `${brandName(contract.brand_id)} · ` : ""}
            {formatDate(contract.period_start)} – {formatDate(contract.period_end)}
          </>
        }
        action={
          <Link href="/contracts" className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink">
            ← All clients
          </Link>
        }
      />

      {showDeployBanner && (
        <div className="mb-6 rounded-xl border border-teal-500/40 bg-teal-500/[0.07] p-4 text-sm text-teal-200 shadow-elevate">
          Deploy complete — <span className="font-semibold">{deployedCount}</span> project
          {deployedCount === 1 ? "" : "s"} created from scope items
          {searchParams?.skipped && Number(searchParams.skipped) > 0
            ? `, ${searchParams.skipped} already linked (skipped).`
            : "."}
        </div>
      )}

      {/* ── Commitment + attainment summary ───────────────────────────────────── */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="GMV target / mo" value={contract.monthly_gmv_target != null ? peso(Number(contract.monthly_gmv_target)) : "—"} valueClassName="text-gold-400" />
        <StatTile label="Content target / mo" value={intOrDash(contract.monthly_content_target)} />
        <StatTile label="Scope on track" value={risk.onTrack} valueClassName="text-teal-400" />
        <StatTile label="Scope behind" value={risk.behind} valueClassName={risk.behind > 0 ? "text-red-400" : "text-ink"} />
      </div>

      {/* ── Scope of work + live attainment ───────────────────────────────────── */}
      <section className="mb-10">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink">Scope of work</h2>
            <p className="text-sm text-ink-muted">Each committed deliverable with its live attainment over the contract window.</p>
          </div>
          {canManage && undeployed > 0 && (
            <form action={deployScope}>
              <input type="hidden" name="contract_id" value={contract.id} />
              <button
                type="submit"
                className="rounded-md bg-teal-500 px-3 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
              >
                Deploy scope to departments ({undeployed})
              </button>
            </form>
          )}
        </div>

        {attainment.length === 0 ? (
          <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">
            No scope items yet.{canManage ? " Add the first below." : ""}
          </p>
        ) : (
          <TableShell columns={["Deliverable", "Department", "Brand", "Type", "Attainment", "Status", ...(canManage ? ["Edit"] : [])]}>
            {attainment.map(({ item, attainment: a }) => (
              <tr key={item.id} className={rowClass}>
                <td className="p-3 align-top">
                  <span className="text-ink">{item.title}</span>
                  {item.project_id && (
                    <Link href="/projects" className="ml-2 font-mono text-[10px] text-teal-300 hover:underline">
                      ▸ {projectName(item.project_id) ?? "project"}
                    </Link>
                  )}
                  {item.target_unit && <div className="text-[11px] text-ink-dim">unit: {item.target_unit}</div>}
                </td>
                <td className="p-3 align-top text-ink-muted">{deptName(item.department_id) ?? "—"}</td>
                <td className="p-3 align-top text-ink-muted">{brandName(item.brand_id) ?? "—"}</td>
                <td className="p-3 align-top">
                  <Badge tone={DELIVERABLE_TONE[a.deliverableType]}>{DELIVERABLE_LABEL[a.deliverableType]}</Badge>
                </td>
                <td className="p-3 align-top min-w-[220px]">
                  <AttainmentMeter attainment={a} showMoney={canSeeFinancials} />
                </td>
                <td className="p-3 align-top">
                  <Badge tone={item.status === "deployed" ? "teal" : "muted"}>
                    {SCOPE_STATUS_LABEL[item.status] ?? item.status}
                  </Badge>
                </td>
                {canManage && (
                  <td className="p-3 align-top">
                    <details>
                      <summary className="cursor-pointer rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-ink-muted hover:bg-charcoal-700 hover:text-ink">
                        Edit
                      </summary>
                      <form action={updateScopeItem} className="mt-2 grid gap-1.5">
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="contract_id" value={contract.id} />
                        <input name="title" defaultValue={item.title} className={fieldCls} />
                        <select name="department_id" defaultValue={item.department_id ?? ""} className={fieldCls}>
                          <option value="">Department…</option>
                          {data.departments.map((d) => (
                            <option key={d.id} value={d.id}>{d.name}</option>
                          ))}
                        </select>
                        <select name="brand_id" defaultValue={item.brand_id ?? ""} className={fieldCls}>
                          <option value="">Brand…</option>
                          {data.brands.map((b) => (
                            <option key={b.id} value={b.id}>{b.name}</option>
                          ))}
                        </select>
                        <select name="deliverable_type" defaultValue={item.deliverable_type} className={fieldCls}>
                          {DELIVERABLE_TYPES_LIST.map((t) => (
                            <option key={t} value={t}>{DELIVERABLE_LABEL[t]}</option>
                          ))}
                        </select>
                        <div className="flex gap-1.5">
                          <input name="target_value" type="number" step="any" defaultValue={item.target_value ?? ""} placeholder="Target" className={`${fieldCls} w-full`} />
                          <input name="target_unit" defaultValue={item.target_unit ?? ""} placeholder="Unit" className={`${fieldCls} w-full`} />
                        </div>
                        <select name="status" defaultValue={item.status} className={fieldCls}>
                          {SCOPE_STATUSES.map((s) => (
                            <option key={s} value={s}>{SCOPE_STATUS_LABEL[s]}</option>
                          ))}
                        </select>
                        <div className="flex items-center gap-2">
                          <button type="submit" className="rounded-md bg-teal-500 px-2.5 py-1 text-[11px] font-semibold text-charcoal-950 hover:bg-teal-400">Save</button>
                        </div>
                      </form>
                      <form action={deleteScopeItem} className="mt-1.5">
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="contract_id" value={contract.id} />
                        <button type="submit" className="rounded-md bg-charcoal-800 px-2.5 py-1 text-[11px] text-red-300 hover:bg-charcoal-700">Delete</button>
                      </form>
                    </details>
                  </td>
                )}
              </tr>
            ))}
          </TableShell>
        )}

        {/* Add scope item */}
        {canManage && (
          <form action={createScopeItem} className="mt-4 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 shadow-elevate">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-muted">Add scope item</p>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <input type="hidden" name="contract_id" value={contract.id} />
              <input name="title" required placeholder="Deliverable title" className={`${inputCls} sm:col-span-3 lg:col-span-2`} />
              <select name="department_id" defaultValue="" className={inputCls}>
                <option value="">Department…</option>
                {data.departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <select name="brand_id" defaultValue={contract.brand_id ?? ""} className={inputCls}>
                <option value="">Brand…</option>
                {data.brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <select name="deliverable_type" defaultValue="content" className={inputCls}>
                {DELIVERABLE_TYPES_LIST.map((t) => (
                  <option key={t} value={t}>{DELIVERABLE_LABEL[t]}</option>
                ))}
              </select>
              <select name="status" defaultValue="planned" className={inputCls}>
                {SCOPE_STATUSES.map((s) => (
                  <option key={s} value={s}>{SCOPE_STATUS_LABEL[s]}</option>
                ))}
              </select>
              <input name="target_value" type="number" step="any" placeholder="Target value" className={inputCls} />
              <input name="target_unit" placeholder="Unit (posts, hours, GMV…)" className={inputCls} />
              <input name="notes" placeholder="Notes (optional)" className={`${inputCls} sm:col-span-3 lg:col-span-4`} />
            </div>
            <button type="submit" className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
              Add scope item
            </button>
            <p className="mt-2 text-[10px] text-ink-dim">
              GMV / Ads read commerce metrics for the brand · Content counts published posts · Live reads session hours or GMV (set unit) · Other is tracked manually.
            </p>
          </form>
        )}
      </section>

      {/* ── Financials (ceo/coo enter; permitted heads can view) ──────────────── */}
      {canSeeFinancials && (
        <SectionCard title="Financials" className="mb-8" action={<Badge tone="amber">Restricted</Badge>}>
          {!isLeadership && (
            <p className="mb-3 text-xs text-ink-muted">
              Read-only — your department has scope on this contract. Only leadership can edit these figures.
            </p>
          )}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">Monthly fee</p>
              <p className="mt-0.5 font-mono text-sm text-gold-300">{fin?.monthly_fee != null ? peso(Number(fin.monthly_fee)) : "—"}</p>
            </div>
            <div className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">Monthly ad budget</p>
              <p className="mt-0.5 font-mono text-sm text-gold-300">{fin?.monthly_ad_budget != null ? peso(Number(fin.monthly_ad_budget)) : "—"}</p>
            </div>
            <div className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3">
              <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">Gross margin</p>
              <p className="mt-0.5 font-mono text-sm text-gold-300">{fin?.gross_margin_pct != null ? `${fin.gross_margin_pct}%` : "—"}</p>
            </div>
          </div>
          {isLeadership && (
            <form action={saveFinancials} className="grid gap-3 sm:grid-cols-3">
              <input type="hidden" name="contract_id" value={contract.id} />
              <input name="monthly_fee" type="number" step="any" defaultValue={fin?.monthly_fee ?? ""} placeholder="Monthly fee" className={inputCls} />
              <input name="monthly_ad_budget" type="number" step="any" defaultValue={fin?.monthly_ad_budget ?? ""} placeholder="Monthly ad budget" className={inputCls} />
              <input name="gross_margin_pct" type="number" step="any" defaultValue={fin?.gross_margin_pct ?? ""} placeholder="Gross margin %" className={inputCls} />
              <input name="notes" defaultValue={fin?.notes ?? ""} placeholder="Notes (optional)" className={`${inputCls} sm:col-span-2`} />
              <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
                Save financials
              </button>
            </form>
          )}
        </SectionCard>
      )}

      {/* ── Edit contract header (writers) ────────────────────────────────────── */}
      {canManage && (
        <SectionCard title="Edit contract" className="mb-8">
          <form action={updateContract} className="grid gap-3 sm:grid-cols-3">
            <input type="hidden" name="id" value={contract.id} />
            <input name="client_name" defaultValue={contract.client_name ?? ""} placeholder="Client name" className={`${inputCls} sm:col-span-2`} />
            <select name="brand_id" defaultValue={contract.brand_id ?? ""} className={inputCls}>
              <option value="">Brand… (optional)</option>
              {data.brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Period start
              <input type="date" name="period_start" defaultValue={contract.period_start ?? ""} className={`${inputCls} mt-1 w-full`} />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Period end
              <input type="date" name="period_end" defaultValue={contract.period_end ?? ""} className={`${inputCls} mt-1 w-full`} />
            </label>
            <select name="status" defaultValue={contract.status} className={inputCls}>
              {CONTRACT_STATUSES.map((s) => (
                <option key={s} value={s}>{CONTRACT_STATUS_LABEL[s]}</option>
              ))}
            </select>
            <input name="monthly_gmv_target" type="number" step="any" defaultValue={contract.monthly_gmv_target ?? ""} placeholder="Monthly GMV target" className={inputCls} />
            <input name="monthly_content_target" type="number" defaultValue={contract.monthly_content_target ?? ""} placeholder="Monthly content target" className={inputCls} />
            <input name="notes" defaultValue={contract.notes ?? ""} placeholder="Notes (optional)" className={inputCls} />
            <textarea
              name="deliverables"
              defaultValue={deliverablesToText(contract.deliverables)}
              placeholder="Deliverables, one per line"
              rows={3}
              className={`${inputCls} sm:col-span-3`}
            />
            <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-3">
              Save contract
            </button>
          </form>
        </SectionCard>
      )}
    </AppShell>
  );
}
