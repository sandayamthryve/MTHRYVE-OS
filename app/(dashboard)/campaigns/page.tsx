import { requireModule } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, StatTile, TableShell, rowClass } from "@/components/ui";
import { requireRole, requireDepartment } from "@/lib/auth/session";
import { COMMERCE_DEPTS } from "@/lib/auth/access-matrix";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { AiBrief } from "@/components/briefings/AiBrief";
import { CampaignBrief } from "@/components/campaigns/CampaignBrief";
import { gatherBrandData, peso, num, returnPct, type BrandData } from "@/lib/briefings/account-data";
import { getLatestAccountBriefing } from "@/lib/briefings/read";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_LABEL,
  CAMPAIGN_TYPE_STYLE,
  DEFAULT_CAMPAIGN_TYPE,
  isCampaignType,
  type CampaignType,
} from "@/lib/campaigns/types";

// M6 — Campaigns. Plan, run, and track marketing campaigns per brand and
// department. Statuses: planning / active / paused / done. Selecting a campaign
// opens a planning panel that grounds the planner in the brand's real situation
// (<AiBrief scope="account">) and lets them generate a grounded, human-approved
// campaign brief via the existing content_generations engine (template_key
// 'campaign_brief').

type Brand = { id: string; name: string };
type Campaign = {
  id: string;
  name: string;
  brand_id: string | null;
  status: string;
  type: string | null;
  department: string | null;
  start_date: string | null;
  end_date: string | null;
  owner_id: string | null;
  notes: string | null;
  created_at: string;
  archived_at: string | null;
};

const STATUSES = ["planning", "active", "paused", "done"] as const;
const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  active: "Active",
  paused: "Paused",
  done: "Done",
};
const STATUS_STYLE: Record<string, string> = {
  planning: "text-ink-muted ring-charcoal-600",
  active: "text-teal-300 ring-teal-500/40",
  paused: "text-amber-300 ring-amber-500/40",
  done: "text-ink-muted ring-charcoal-600",
};

const DEPARTMENTS = ["E-Commerce", "Creative", "Affiliate", "Live Operations", "Business Development"];

type DbShim = {
  from: (t: string) => {
    insert: (v: Record<string, unknown>) => Promise<unknown>;
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

async function createCampaign(formData: FormData) {
  "use server";
  const profile = (await requireRole(["ceo", "coo", "department_head", "team_member"])) as unknown as {
    id: string;
    org_id: string;
  };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  // Validate the type against the allowed set BEFORE insert. A missing value is
  // the honest default 'campaign'; a present-but-bad value (only reachable via a
  // crafted request, never the fixed <select>) is refused here so it can never
  // reach — and be rejected 500 by — the DB CHECK. This is the 400-not-500 gate.
  const rawType = String(formData.get("type") ?? "").trim();
  const type: CampaignType = rawType === "" ? DEFAULT_CAMPAIGN_TYPE : (rawType as CampaignType);
  if (!isCampaignType(type)) return;

  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim).from("campaigns").insert({
    org_id: profile.org_id,
    created_by: profile.id,
    owner_id: profile.id,
    name,
    type,
    brand_id: String(formData.get("brand_id") ?? "") || null,
    department: String(formData.get("department") ?? "") || null,
    start_date: String(formData.get("start_date") ?? "") || null,
    end_date: String(formData.get("end_date") ?? "") || null,
    notes: String(formData.get("notes") ?? "") || null,
    status: "planning",
  });
  revalidatePath("/campaigns");
}

// Re-classify a campaign's type from the inline row editor. Same 400-not-500
// gate: an unknown target is refused before the update, so the DB CHECK is never
// the thing that rejects it. RLS still scopes which row can be touched.
async function updateCampaignType(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const id = String(formData.get("id") ?? "");
  const type = String(formData.get("type") ?? "");
  if (!id || !isCampaignType(type)) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("campaigns")
    .update({ type, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/campaigns");
}

async function updateStatus(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "planning");
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("campaigns")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/campaigns");
}

// Save an approved campaign-brief draft onto the campaign's notes. The draft is
// already ledgered as a content_generations row by the generator; this is the
// optional human step of pinning it to the campaign.
async function saveBriefToNotes(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo", "department_head", "team_member"]);
  const id = String(formData.get("campaign_id") ?? "");
  const draft = String(formData.get("draft") ?? "").trim();
  if (!id) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("campaigns")
    .update({ notes: draft, updated_at: new Date().toISOString() })
    .eq("id", id);
  revalidatePath("/campaigns");
}

// Compact, code-truthful one-liner of the brand's latest platform metrics — fed
// to the campaign-brief generator so it grounds on real figures, never invents.
function brandMetricsLine(data: BrandData): string {
  const latest = data.bpm[0];
  if (!latest) return "";
  const parts: string[] = [];
  if (latest.gmv != null) parts.push(`GMV ${peso(num(latest.gmv))}`);
  if (latest.orders != null) parts.push(`${latest.orders} orders`);
  const rp = returnPct(latest.return_rate);
  if (rp != null) parts.push(`return rate ${rp.toFixed(1)}%`);
  if (latest.roas != null) parts.push(`ROAS ${Number(latest.roas)}x`);
  const period = `${latest.period_start ?? "?"} → ${latest.period_end ?? "?"}`;
  return `${parts.join(", ")} (period ${period}, source ${latest.source}).`;
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams?: { c?: string; archived?: string; type?: string };
}) {
  // Commerce operating page — department-scoped (E-Commerce Ops + Warehouse),
  // leadership bypasses. RLS still scopes rows underneath.
  const profile = await requireModule("/campaigns");
  const supabase = createServerSupabaseClient();
  const archived = searchParams?.archived === "1";

  // Type filter/tabs — a validated ?type= value narrows the one table; anything
  // else (missing / garbage) falls back to "all".
  const typeParam = (searchParams?.type ?? "").trim();
  const typeFilter: CampaignType | "all" = isCampaignType(typeParam) ? typeParam : "all";

  // Default list hides archived campaigns; the Archived view shows only them.
  const campQuery = supabase
    .from("campaigns")
    .select("id, name, brand_id, status, type, department, start_date, end_date, owner_id, notes, created_at, archived_at")
    .order("created_at", { ascending: false });

  const [brandRes, campRes] = await Promise.all([
    supabase.from("brands").select("id, name").is("archived_at", null).order("name"),
    archived ? campQuery.not("archived_at", "is", null) : campQuery.is("archived_at", null),
  ]);

  const brands = (brandRes.data ?? []) as unknown as Brand[];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const allCampaigns = (campRes.data ?? []) as unknown as Campaign[];
  // Counts per type over the FULL loaded set drive the tab badges; a null/unknown
  // stored type counts as the default 'campaign'.
  const effType = (c: Campaign): string => (isCampaignType(c.type) ? c.type : DEFAULT_CAMPAIGN_TYPE);
  const countByType = (t: CampaignType) => allCampaigns.filter((c) => effType(c) === t).length;
  const campaigns =
    typeFilter === "all" ? allCampaigns : allCampaigns.filter((c) => effType(c) === typeFilter);
  const countBy = (s: string) => campaigns.filter((c) => c.status === s).length;

  // Preserve the archived flag on the tab links so switching type keeps the view.
  const typeHref = (t: CampaignType | "all") =>
    `/campaigns?${new URLSearchParams({
      ...(archived ? { archived: "1" } : {}),
      ...(t === "all" ? {} : { type: t }),
    }).toString()}`.replace(/\?$/, "");

  const selectedId = (searchParams?.c ?? "").trim();
  const selected = campaigns.find((c) => c.id === selectedId) ?? null;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Campaigns"]} profile={profile}>
      <PageHeader
        title="Campaigns"
        subtitle="Plan and track marketing campaigns across brands and departments."
      />

      {/* Type filter — tabs over the one campaigns table. "All" plus the four
          kinds; the active tab narrows the list below and seeds the create form. */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-charcoal-700/60">
        <a
          href={typeHref("all")}
          aria-current={typeFilter === "all" ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            typeFilter === "all"
              ? "border-teal-400 text-teal-300"
              : "border-transparent text-ink-muted hover:text-ink"
          }`}
        >
          All <span className="text-ink-dim">({allCampaigns.length})</span>
        </a>
        {CAMPAIGN_TYPES.map((t) => {
          const on = typeFilter === t;
          return (
            <a
              key={t}
              href={typeHref(t)}
              aria-current={on ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                on ? "border-teal-400 text-teal-300" : "border-transparent text-ink-muted hover:text-ink"
              }`}
            >
              {CAMPAIGN_TYPE_LABEL[t]} <span className="text-ink-dim">({countByType(t)})</span>
            </a>
          );
        })}
      </div>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          {STATUSES.map((s) => (
            <StatTile key={s} label={STATUS_LABEL[s]} value={countBy(s)} />
          ))}
        </div>
      </div>
      <div className="mb-6 flex justify-end">
        <ArchivedToggle basePath="/campaigns" archived={archived} />
      </div>

      {!archived && (
      <form action={createCampaign} className="mb-6 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
        <div className="grid gap-3 sm:grid-cols-3">
          <input name="name" required placeholder="Campaign name" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink sm:col-span-2" />
          <select
            name="type"
            aria-label="Type"
            defaultValue={typeFilter === "all" ? DEFAULT_CAMPAIGN_TYPE : typeFilter}
            className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink"
          >
            {CAMPAIGN_TYPES.map((t) => (
              <option key={t} value={t}>{CAMPAIGN_TYPE_LABEL[t]}</option>
            ))}
          </select>
          <select name="brand_id" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
            <option value="">Brand (optional)…</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select name="department" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink">
            <option value="">Department…</option>
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <label className="text-xs text-ink-muted">
            Start
            <input name="start_date" type="date" className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
          </label>
          <label className="text-xs text-ink-muted">
            End
            <input name="end_date" type="date" className="mt-1 w-full rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink" />
          </label>
          <input name="notes" placeholder="Notes / goal (optional)" className="rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink sm:col-span-3" />
        </div>
        <button type="submit" className="mt-3 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">
          Add campaign
        </button>
      </form>
      )}

      <TableShell columns={["Campaign", "Brand", "Type", "Dept", "Dates", "Status", "Plan", "Manage"]}>
        {campaigns.length === 0 && (
          <tr>
            <td colSpan={8} className="p-4 text-ink-muted">
              {archived
                ? "No archived campaigns."
                : typeFilter === "all"
                  ? "No campaigns yet — add your first above."
                  : `No ${CAMPAIGN_TYPE_LABEL[typeFilter].toLowerCase()} campaigns yet.`}
            </td>
          </tr>
        )}
        {campaigns.map((c) => {
          const cType = (isCampaignType(c.type) ? c.type : DEFAULT_CAMPAIGN_TYPE) as CampaignType;
          return (
              <tr key={c.id} className={`${rowClass} ${c.id === selectedId ? "bg-charcoal-800/40" : ""}`}>
                <td className="p-3">
                  <span className="text-ink">{c.name}</span>
                  {c.notes ? <span className="block text-xs text-ink-muted">{c.notes}</span> : ""}
                </td>
                <td className="p-3 text-ink-muted">{brandName(c.brand_id)}</td>
                <td className="p-3">
                  <form action={updateCampaignType} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={c.id} />
                    <select
                      name="type"
                      defaultValue={cType}
                      aria-label="Type"
                      className={`rounded-md border-0 bg-charcoal-950 p-1.5 text-xs ring-1 ${CAMPAIGN_TYPE_STYLE[cType]}`}
                    >
                      {CAMPAIGN_TYPES.map((t) => (
                        <option key={t} value={t}>{CAMPAIGN_TYPE_LABEL[t]}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700">Save</button>
                  </form>
                </td>
                <td className="p-3 text-ink-muted">{c.department ?? "—"}</td>
                <td className="p-3 font-mono text-xs text-ink-muted">
                  {c.start_date ?? "—"}{c.end_date ? ` → ${c.end_date}` : ""}
                </td>
                <td className="p-3">
                  <form action={updateStatus} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={c.id} />
                    <select
                      name="status"
                      defaultValue={c.status}
                      className={`rounded-md border-0 bg-charcoal-950 p-1.5 text-xs ring-1 ${STATUS_STYLE[c.status] ?? STATUS_STYLE.planning}`}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                      ))}
                    </select>
                    <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-xs text-teal-300 hover:bg-charcoal-700">Save</button>
                  </form>
                </td>
                <td className="p-3">
                  <a
                    href={`/campaigns?c=${c.id}`}
                    className="rounded-md border border-charcoal-700 px-2.5 py-1 text-xs text-teal-300 hover:bg-charcoal-800"
                  >
                    {c.id === selectedId ? "Selected" : "Plan"}
                  </a>
                </td>
                <td className="p-3">
                  <RowActions {...rowActionProps("campaigns", c as unknown as Record<string, unknown>, profile)} />
                </td>
              </tr>
          );
        })}
      </TableShell>

      {selected ? await PlanningPanel(supabase, selected, brandName(selected.brand_id)) : null}
    </AppShell>
  );
}

async function PlanningPanel(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  campaign: Campaign,
  brandLabel: string
) {
  // Compose the grounded brand context for the brief generator (server-side).
  let brandData: BrandData | null = null;
  let acctBrief = null as Awaited<ReturnType<typeof getLatestAccountBriefing>>;
  let ownerName: string | null = null;

  if (campaign.brand_id) {
    [brandData, acctBrief] = await Promise.all([
      gatherBrandData(supabase, campaign.brand_id),
      getLatestAccountBriefing(supabase, campaign.brand_id),
    ]);
  }
  if (campaign.owner_id) {
    const ownerRes = await supabase
      .from("users")
      .select("full_name")
      .eq("id", campaign.owner_id)
      .single();
    ownerName = (ownerRes.data as unknown as { full_name: string } | null)?.full_name ?? null;
  }

  const metricsLine = brandData ? brandMetricsLine(brandData) : "";
  const hasBrandContext = !!(acctBrief?.summary || metricsLine);

  const inputs: Record<string, string> = {
    campaign_name: campaign.name,
    status: campaign.status,
    department: campaign.department ?? "",
    dates: [campaign.start_date, campaign.end_date].filter(Boolean).join(" → "),
    owner: ownerName ?? "",
    notes: campaign.notes ?? "",
    brand_name: campaign.brand_id ? brandLabel : "",
    brand_summary: acctBrief?.summary ?? "",
    brand_challenges: (acctBrief?.challenges ?? []).join("; "),
    brand_solutions: (acctBrief?.solutions ?? []).map((s) => s.solution).join("; "),
    brand_metrics: metricsLine,
    confidence_note:
      acctBrief?.data_confidence ??
      (metricsLine ? "platform metrics only, no account briefing on file" : "no brand data on file — low confidence"),
  };

  return (
    <section className="mt-8 space-y-5 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink">Plan · {campaign.name}</h2>
          <p className="text-xs text-ink-muted">
            {campaign.brand_id ? brandLabel : "No brand linked"}
            {campaign.department ? ` · ${campaign.department}` : ""}
          </p>
        </div>
        <a href="/campaigns" className="text-xs text-ink-muted hover:text-ink">
          Close
        </a>
      </div>

      {/* Grounding context — the brand's real situation while planning. */}
      {campaign.brand_id ? (
        <AiBrief scope="account" id={campaign.brand_id} />
      ) : (
        <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-4">
          <p className="text-sm text-ink-muted">
            Link a brand to this campaign to see its brief — GMV trend, returns, challenges, and recommended actions —
            while you plan.
          </p>
        </div>
      )}

      {/* Grounded, human-approved campaign brief draft. */}
      <div className="rounded-lg border border-charcoal-700 bg-charcoal-950 p-4">
        <CampaignBrief
          campaignId={campaign.id}
          inputs={inputs}
          hasBrandContext={hasBrandContext}
          saveAction={saveBriefToNotes}
        />
      </div>
    </section>
  );
}
