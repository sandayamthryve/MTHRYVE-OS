import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass, Badge } from "@/components/ui";
import { AffiliateTabs } from "@/components/affiliate/AffiliateTabs";
import { AddSourcedCreatorForm } from "@/components/affiliate/AddSourcedCreatorForm";
import { ImportSourcingControl } from "@/components/affiliate/ImportSourcingControl";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { intOrDash, pesoOrDash, EMPTY } from "@/lib/metrics/format";
import {
  MANAGE_ROLES,
  PIPELINE_STAGES,
  STAGE_LABEL,
  stageForStatus,
  agingTone,
  rollUpKpi,
  daysSince,
  type LinkedCreatorLite,
  type PipelineStage,
} from "@/lib/affiliate/domain";
import { addSourcedCreator, importSourcing, moveCreatorStage } from "../../actions";

// SECTION 1 (detail) — one campaign: the live KPI tracker (actuals rolled up from
// linked creators, shown against the stored targets), sourcing (add / import
// creators — dedup links existing), and the qualification pipeline (a stage view
// over creators.status with aging/SLA from recruited_at). No new DB columns.
export const dynamic = "force-dynamic";

type Db = { from: (t: string) => any };

const PLATFORM_OPTIONS = [
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "youtube", label: "YouTube" },
  { value: "other", label: "Other" },
];

type Campaign = {
  id: string;
  title: string | null;
  brand_id: string | null;
  status: string | null;
  start_date: string | null;
  end_date: string | null;
  details: {
    fit?: Record<string, unknown> | null;
    kpi_target?: Record<string, number | null> | null;
  } | null;
};

type Creator = {
  id: string;
  name: string | null;
  handle: string | null;
  platform: string | null;
  status: string | null;
  follower_count: number | null;
  email: string | null;
};

// "actual / target" — target is a target, never conflated with the actual. A
// null actual reads "—"; an absent target reads "no target".
function TrackerTile({
  label,
  actual,
  target,
  money,
}: {
  label: string;
  actual: number | null;
  target: number | null | undefined;
  money?: boolean;
}) {
  const actualStr = actual == null ? EMPTY : money ? pesoOrDash(actual) : intOrDash(actual);
  const targetStr =
    target == null ? "no target" : money ? pesoOrDash(target) : intOrDash(target);
  return <StatTile label={label} value={actualStr} hint={`Target: ${targetStr}`} />;
}

export default async function CampaignDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireModule("/affiliate");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;
  const now = Date.now();

  const { data: campaignRow } = await db
    .from("op_records")
    .select("id, title, brand_id, status, start_date, end_date, details")
    .eq("id", params.id)
    .eq("record_type", "campaign")
    .maybeSingle();
  const campaign = campaignRow as Campaign | null;
  if (!campaign) notFound();

  const [linksRes, creatorsRes, contentRes, usersRes, brandsRes] = await Promise.all([
    db
      .from("affiliate_campaign_creators")
      .select("id, creator_id, recruited_at, sourcer_id, created_at")
      .eq("campaign_id", campaign.id)
      .order("recruited_at", { ascending: false }),
    db
      .from("creators")
      .select("id, name, handle, platform, status, follower_count, email")
      .order("created_at", { ascending: false }),
    db.from("affiliate_content").select("gmv").eq("campaign_id", campaign.id),
    supabase.from("users").select("id, full_name"),
    supabase.from("brands").select("id, name"),
  ]);

  const linkRows = (linksRes.data ?? []) as {
    id: string;
    creator_id: string;
    recruited_at: string | null;
    sourcer_id: string | null;
    created_at: string | null;
  }[];
  const creators = (creatorsRes.data ?? []) as Creator[];
  const creatorById = new Map(creators.map((c) => [c.id, c]));
  const content = (contentRes.data ?? []) as { gmv: number | null }[];
  const users = (usersRes.data ?? []) as { id: string; full_name: string }[];
  const userName = (id: string | null) => (id ? users.find((u) => u.id === id)?.full_name ?? EMPTY : EMPTY);
  const brands = (brandsRes.data ?? []) as { id: string; name: string }[];
  const brandName = campaign.brand_id ? brands.find((b) => b.id === campaign.brand_id)?.name ?? EMPTY : EMPTY;

  // Assemble the roster: each link joined to its creator, with stage + aging.
  const roster = linkRows
    .map((l) => {
      const creator = creatorById.get(l.creator_id);
      if (!creator) return null;
      const stage = stageForStatus(creator.status);
      const age = daysSince(l.recruited_at, now);
      return { link: l, creator, stage, age };
    })
    .filter(Boolean) as {
    link: (typeof linkRows)[number];
    creator: Creator;
    stage: PipelineStage | null;
    age: number | null;
  }[];

  const linkedLite: LinkedCreatorLite[] = roster.map((r) => ({
    status: r.creator.status,
    follower_count: r.creator.follower_count,
  }));
  const kpi = rollUpKpi(linkedLite, content.map((c) => c.gmv));
  const target = campaign.details?.kpi_target ?? {};
  const fit = campaign.details?.fit ?? {};

  // Group roster by pipeline stage for the board (inactive creators sit in an
  // off-ramp column so they're never counted as active).
  const byStage = new Map<PipelineStage | "off", typeof roster>();
  for (const s of PIPELINE_STAGES) byStage.set(s, []);
  byStage.set("off", []);
  for (const r of roster) {
    const key = r.stage ?? "off";
    byStage.get(key)!.push(r);
  }

  return (
    <AppShell breadcrumb={["Mthryve OS", "Affiliate", campaign.title ?? "Campaign"]} profile={profile}>
      <PageHeader
        title={campaign.title ?? "Untitled campaign"}
        subtitle={`${brandName === EMPTY ? "No brand" : brandName} · ${campaign.status ?? "draft"}`}
        action={
          <Link href="/affiliate" className="text-sm text-teal-300 hover:underline">
            ← All campaigns
          </Link>
        }
      />
      <AffiliateTabs />

      {/* KPI tracker — live actuals vs stored targets */}
      <SectionCard title="KPI tracker" className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <TrackerTile label="Sourced" actual={kpi.sourced} target={target.sourced} />
          <TrackerTile label="Qualified" actual={kpi.qualified} target={target.qualified} />
          <TrackerTile label="Active" actual={kpi.active} target={target.active} />
          <TrackerTile label="Follower reach" actual={kpi.reach} target={target.reach} />
          <TrackerTile label="Attributed GMV" actual={kpi.gmv} target={target.gmv} money />
        </div>
        <p className="mt-3 text-[11px] text-ink-dim">
          Actuals are counted live from this campaign’s linked creators and their attributed content.
          A target is never shown as an actual; unknown actuals read “—”.
        </p>
        {Boolean(fit.min_followers || fit.category || fit.platform || fit.region || fit.notes) && (
          <div className="mt-4 flex flex-wrap gap-2">
            {fit.min_followers ? <Badge tone="muted">Min followers: {String(fit.min_followers)}</Badge> : null}
            {fit.category ? <Badge tone="muted">Category: {String(fit.category)}</Badge> : null}
            {fit.platform ? <Badge tone="muted">Platform: {String(fit.platform)}</Badge> : null}
            {fit.region ? <Badge tone="muted">Region: {String(fit.region)}</Badge> : null}
            {fit.notes ? <Badge tone="muted">{String(fit.notes)}</Badge> : null}
          </div>
        )}
      </SectionCard>

      {/* Sourcing */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <AddSourcedCreatorForm action={addSourcedCreator} campaignId={campaign.id} platforms={PLATFORM_OPTIONS} />
        <ImportSourcingControl action={importSourcing} campaignId={campaign.id} />
      </div>

      {/* Qualification pipeline — stage columns with aging/SLA */}
      <SectionCard title="Qualification pipeline" className="mb-6">
        <div className="grid gap-3 md:grid-cols-4">
          {PIPELINE_STAGES.map((stage) => {
            const items = byStage.get(stage) ?? [];
            return (
              <div key={stage} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">{STAGE_LABEL[stage]}</span>
                  <span className="font-mono text-[10px] text-ink-dim">{items.length}</span>
                </div>
                <div className="space-y-2">
                  {items.length === 0 ? (
                    <p className="text-[11px] text-ink-dim">—</p>
                  ) : (
                    items.map((r) => (
                      <div key={r.link.id} className="rounded-md border border-charcoal-700/60 bg-charcoal-900 p-2">
                        <p className="truncate text-xs font-medium text-ink">{r.creator.name ?? "Unknown"}</p>
                        <div className="mt-1 flex items-center gap-1">
                          <Badge tone={agingTone(stage, r.age)}>
                            {r.age == null ? "age —" : `${r.age}d`}
                          </Badge>
                        </div>
                        <form action={moveCreatorStage} className="mt-2 flex items-center gap-1">
                          <input type="hidden" name="campaign_id" value={campaign.id} />
                          <input type="hidden" name="creator_id" value={r.creator.id} />
                          <select
                            name="stage"
                            defaultValue={stage}
                            aria-label="Move stage"
                            className="w-full rounded border border-charcoal-700 bg-charcoal-950 p-1 text-[11px] text-ink"
                          >
                            {PIPELINE_STAGES.map((s) => (
                              <option key={s} value={s}>
                                {STAGE_LABEL[s]}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="shrink-0 rounded bg-charcoal-800 px-2 py-1 text-[11px] text-ink hover:bg-charcoal-700"
                          >
                            Move
                          </button>
                        </form>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {(byStage.get("off") ?? []).length > 0 && (
          <p className="mt-3 text-[11px] text-ink-dim">
            {(byStage.get("off") ?? []).length} inactive creator(s) are off the active pipeline.
          </p>
        )}
      </SectionCard>

      {/* Full roster */}
      <SectionCard title="Roster" bodyClassName="p-0">
        {roster.length === 0 ? (
          <p className="p-5 text-sm text-ink-muted">
            No creators sourced yet. Add or import creators above.
          </p>
        ) : (
          <TableShell columns={["Creator", "Handle", "Platform", "Stage", "Reach", "Recruited", "Age", "Sourced by"]}>
            {roster.map((r) => (
              <tr key={r.link.id} className={rowClass}>
                <td className="p-3">
                  <Link href={`/creators/${r.creator.id}`} className="font-medium text-ink hover:text-teal-300">
                    {r.creator.name ?? "Unknown"}
                  </Link>
                </td>
                <td className="p-3 text-ink-muted">{r.creator.handle ?? EMPTY}</td>
                <td className="p-3 text-ink-muted">{r.creator.platform ?? EMPTY}</td>
                <td className="p-3">
                  {r.stage ? <Badge tone="violet">{STAGE_LABEL[r.stage]}</Badge> : <Badge tone="muted">inactive</Badge>}
                </td>
                <td className="p-3 font-mono text-ink">{intOrDash(r.creator.follower_count)}</td>
                <td className="p-3 text-ink-muted">{r.link.recruited_at?.slice(0, 10) ?? EMPTY}</td>
                <td className="p-3">
                  <Badge tone={r.stage ? agingTone(r.stage, r.age) : "muted"}>
                    {r.age == null ? EMPTY : `${r.age}d`}
                  </Badge>
                </td>
                <td className="p-3 text-ink-muted">{userName(r.link.sourcer_id)}</td>
              </tr>
            ))}
          </TableShell>
        )}
      </SectionCard>
    </AppShell>
  );
}
