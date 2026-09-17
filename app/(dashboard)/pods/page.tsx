import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, HelpHint } from "@/components/ui";
import { requireProfile } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  PodsManager,
  type PodView,
  type PodBrandLite,
  type UserLite,
} from "@/components/pods/PodsManager";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import { sumPnl, type PodPnl } from "@/components/pods/PodPnl";

// Pods — the Growth Pod manager. Leadership creates a pod, sets its lead and
// target, and assigns brands (clients) to it; everyone can read. Brand
// assignments here are what the Growth Scoreboard rolls up per pod.
//
// The view is read-open (RLS: pods/pod_brands select is org-scoped). The write
// controls are shown only to leadership (ceo/coo/department_head), matching the
// pods_write / pod_brands_write policies — RLS remains the real guard.
//
// pods / pod_brands aren't in the generated Database types (provisioned
// out-of-band; see 0023), so they're read through the app's cast shim.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };
const LEADERSHIP = ["ceo", "coo", "department_head"];
// Finance-sensitive P&L is tighter than pod management: ceo/coo only, matching
// the /finance gate. department_head manages pods but never sees the money.
const FINANCE = ["ceo", "coo"];

// Numeric columns come back from the pod_pnl view as strings (PostgREST casts
// numeric → text). Coerce to a real number, keeping null honest as null.
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function PodsPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const archived = searchParams?.archived === "1";
  const profile = await requireProfile();
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  // Finance gate: the P&L strip is ceo/coo-only. We skip the pod_pnl read
  // entirely for everyone else so the sensitive figures never leave the DB. The
  // pod_pnl view is security_invoker, so RLS is the real guard either way.
  const canSeePnl = FINANCE.includes(profile.role);

  const podsQ = db
    .from("pods")
    .select("id, name, lead_user_id, target_brands, status, notes, archived_at")
    .eq("org_id", profile.org_id)
    .order("name");
  const [podsRes, podBrandsRes, brandsRes, usersRes, pnlRes] = await Promise.all([
    archived ? podsQ.not("archived_at", "is", null) : podsQ.is("archived_at", null),
    db.from("pod_brands").select("pod_id, brand_id").eq("org_id", profile.org_id),
    db.from("brands").select("id, name").eq("org_id", profile.org_id).order("name"),
    db.from("users").select("id, full_name").eq("org_id", profile.org_id).order("full_name"),
    canSeePnl
      ? db
          .from("pod_pnl")
          .select(
            "pod_id, retainer_revenue_monthly, gmv_synced, take_revenue_on_gmv, revenue_total, gross_contribution_pre_labor, direct_labor_cost, net_contribution_margin",
          )
          .eq("org_id", profile.org_id)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  // Raw pod rows (with notes + archived_at) for the shared archive/edit control.
  const rawPods = (podsRes.data ?? []) as Array<{
    id: string;
    name: string;
    target_brands: number | null;
    notes: string | null;
    archived_at: string | null;
  }>;

  const brands = (brandsRes.data ?? []) as PodBrandLite[];
  const users = ((usersRes.data ?? []) as Array<{ id: string; full_name: string }>).map((u) => ({
    id: u.id,
    name: u.full_name,
  })) as UserLite[];
  const brandName = new Map(brands.map((b) => [b.id, b.name]));
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const brandsByPod = new Map<string, PodBrandLite[]>();
  for (const pb of (podBrandsRes.data ?? []) as Array<{ pod_id: string; brand_id: string }>) {
    const list = brandsByPod.get(pb.pod_id) ?? [];
    if (brandName.has(pb.brand_id)) list.push({ id: pb.brand_id, name: brandName.get(pb.brand_id)! });
    brandsByPod.set(pb.pod_id, list);
  }

  const pods: PodView[] = ((podsRes.data ?? []) as Array<{
    id: string;
    name: string;
    lead_user_id: string | null;
    target_brands: number | null;
    status: string;
  }>).map((p) => ({
    id: p.id,
    name: p.name,
    leadUserId: p.lead_user_id,
    leadName: p.lead_user_id ? userName.get(p.lead_user_id) ?? null : null,
    targetBrands: p.target_brands,
    status: p.status,
    brands: (brandsByPod.get(p.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const canManage = LEADERSHIP.includes(profile.role);
  const assignedCount = new Set((podBrandsRes.data ?? []).map((pb: { brand_id: string }) => pb.brand_id)).size;

  // Map pod_pnl rows to the view shape, keyed by pod id. Present only for
  // ceo/coo (canSeePnl); everyone else gets an empty read and no strip renders.
  // direct_labor_cost + net_contribution_margin are carried through as-is — the
  // view leaves them null (payroll untracked) and the UI renders that as "—".
  let pnl: Record<string, PodPnl> | undefined;
  let pnlTotal: PodPnl | undefined;
  if (canSeePnl) {
    pnl = {};
    for (const r of (pnlRes.data ?? []) as Array<Record<string, unknown>>) {
      const podId = r.pod_id as string | undefined;
      if (!podId) continue;
      pnl[podId] = {
        retainerMonthly: num(r.retainer_revenue_monthly),
        gmvSynced: num(r.gmv_synced),
        takeRevenue: num(r.take_revenue_on_gmv),
        revenueTotal: num(r.revenue_total),
        grossPreLabor: num(r.gross_contribution_pre_labor),
        directLabor: num(r.direct_labor_cost),
        netContribution: num(r.net_contribution_margin),
      };
    }
    // Summary sums only the pods actually on screen (respects the archived toggle).
    pnlTotal = sumPnl(pods.map((p) => pnl![p.id]).filter(Boolean) as PodPnl[]);
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "Growth", "Pods"]} profile={profile}>
      <PageHeader
        title={<>Growth Pods <HelpHint id="money.podPnl" /></>}
        subtitle={`${pods.length} pod${pods.length === 1 ? "" : "s"} · ${assignedCount}/${brands.length} brands under pod management`}
      />
      <PodsManager
        pods={pods}
        brands={brands}
        users={users}
        canManage={canManage}
        pnl={pnl}
        pnlTotal={pnlTotal}
      />

      <div className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">
            {archived ? "Archived pods" : "Manage pods"}
          </h2>
          <ArchivedToggle basePath="/pods" archived={archived} />
        </div>
        {rawPods.length === 0 ? (
          <div className="rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-ink-muted">
            {archived ? "No archived pods." : "No pods yet."}
          </div>
        ) : (
          <div className="space-y-1.5">
            {rawPods.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-md border border-charcoal-700 bg-charcoal-900 px-3 py-2"
              >
                <span className="text-sm text-ink">{p.name}</span>
                <RowActions
                  {...rowActionProps("pods", p as unknown as Record<string, unknown>, profile)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
