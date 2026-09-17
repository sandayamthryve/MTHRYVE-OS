import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, StatTile, TableShell, Badge, rowClass } from "@/components/ui";
import { AttainmentMeter } from "@/components/contracts/AttainmentMeter";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadContractsData, buildScopeAttainment } from "@/lib/contracts/data";
import { deliveryRisk } from "@/lib/metrics/contracts";
import {
  DELIVERABLE_LABEL,
  DELIVERABLE_TONE,
  SCOPE_STATUS_LABEL,
} from "@/lib/contracts/display";

// "My delivery" — the caller's own department's committed scope across every
// client, with live attainment and the project each item deployed into. A
// focused cut of the same transparency data so a department sees exactly what it
// owes, and how it's tracking, without the org-wide noise.

export const dynamic = "force-dynamic";

// Rank the caller's items so anything behind floats to the top.
const FLAG_ORDER: Record<string, number> = {
  behind: 0,
  on_track: 1,
  no_data: 2,
  no_target: 3,
  manual: 4,
};

export default async function MyDeliveryPage() {
  const profile = await requireModule("/contracts");
  const supabase = createServerSupabaseClient();
  const data = await loadContractsData(supabase);

  const deptId = profile.department_id;
  const myDept = data.departments.find((d) => d.id === deptId)?.name ?? null;

  const brandName = (id: string | null) => data.brands.find((b) => b.id === id)?.name ?? null;
  const clientName = (contractId: string) =>
    data.contracts.find((c) => c.id === contractId)?.client_name ?? "—";
  const projectName = (id: string | null) => data.projects.find((p) => p.id === id)?.name ?? null;

  const myItems = deptId ? data.scopeItems.filter((i) => i.department_id === deptId) : [];
  const attainment = buildScopeAttainment(data, myItems).sort(
    (a, b) => (FLAG_ORDER[a.attainment.flag] ?? 9) - (FLAG_ORDER[b.attainment.flag] ?? 9)
  );
  const risk = deliveryRisk(attainment);
  const clientsServed = new Set(myItems.map((i) => i.contract_id)).size;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Client Delivery", "My delivery"]} profile={profile}>
      <PageHeader
        title="My delivery"
        subtitle={
          myDept
            ? `${myDept} — your committed scope across all clients, with live attainment.`
            : "Your committed scope across all clients."
        }
        action={
          <Link href="/contracts" className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:bg-charcoal-800 hover:text-ink">
            All clients →
          </Link>
        }
      />

      {!deptId ? (
        <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">
          You're not assigned to a department, so there's no departmental scope to show. See the{" "}
          <Link href="/contracts" className="text-teal-300 hover:underline">all-client transparency view</Link>.
        </p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile label="Deliverables" value={myItems.length} hint={`across ${clientsServed} client${clientsServed === 1 ? "" : "s"}`} />
            <StatTile label="On track" value={risk.onTrack} valueClassName="text-teal-400" />
            <StatTile label="Behind" value={risk.behind} valueClassName={risk.behind > 0 ? "text-red-400" : "text-ink"} />
            <StatTile label="Deployed" value={myItems.filter((i) => i.project_id).length} hint="linked to a project" />
          </div>

          {attainment.length === 0 ? (
            <p className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 text-sm text-ink-muted shadow-elevate">
              No scope items are assigned to {myDept ?? "your department"} yet.
            </p>
          ) : (
            <TableShell columns={["Client", "Deliverable", "Brand", "Type", "Attainment", "Project", "Status"]}>
              {attainment.map(({ item, attainment: a }) => (
                <tr key={item.id} className={rowClass}>
                  <td className="p-3">
                    <Link href={`/contracts/${item.contract_id}`} className="text-ink hover:text-teal-300">
                      {clientName(item.contract_id)}
                    </Link>
                  </td>
                  <td className="p-3 text-ink">{item.title}</td>
                  <td className="p-3 text-ink-muted">{brandName(item.brand_id) ?? "—"}</td>
                  <td className="p-3">
                    <Badge tone={DELIVERABLE_TONE[a.deliverableType]}>{DELIVERABLE_LABEL[a.deliverableType]}</Badge>
                  </td>
                  <td className="p-3 min-w-[220px]">
                    {/* Money shown only where financials were readable for this contract. */}
                    <AttainmentMeter attainment={a} showMoney={data.financialsByContract.has(item.contract_id)} />
                  </td>
                  <td className="p-3">
                    {item.project_id ? (
                      <Link href="/projects" className="font-mono text-[11px] text-teal-300 hover:underline">
                        ▸ {projectName(item.project_id) ?? "project"}
                      </Link>
                    ) : (
                      <span className="text-ink-dim">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <Badge tone={item.status === "deployed" ? "teal" : "muted"}>
                      {SCOPE_STATUS_LABEL[item.status] ?? item.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </TableShell>
          )}
        </>
      )}
    </AppShell>
  );
}
