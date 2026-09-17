import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, TableShell, rowClass, Badge } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { peso, pesoOrDash, int } from "@/lib/metrics/format";
import { manilaStamp, parseWeekSelector, resolveIsoWeek } from "@/lib/metrics/windows";
import { safeUrl } from "@/lib/security/sanitize";
import {
  computeStandardKpi,
  resolveTier,
  VERDICT_LABEL,
  verdictTone,
  type StandardCreator,
  type TierRow,
} from "@/lib/affiliate/standards";
import { VesperReachPanel } from "@/components/outreach/VesperReachPanel";

// Creator detail — the per-creator view of the affiliate performance standard.
// Shows the resolved tier, the three-part standard broken out (cadence, GMV,
// follower band), the badge, and the posts backing the weekly rate, honouring
// the same current/last-completed ISO week toggle as the registry. Read for
// leadership + the affiliate team (org-scoped per RLS). No writes.

export const dynamic = "force-dynamic";

type Shim = { from: (t: string) => any };

const DEAL_STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed",
  active: "Active",
  paused: "Paused",
  ended: "Ended",
};

// One part of the three-part standard, with an honest pass/fail/unknown state.
function PartCard({
  label,
  value,
  detail,
  state,
}: {
  label: string;
  value: string;
  detail: string;
  state: "meets" | "below" | "at_risk" | "unknown";
}) {
  const tone = state === "meets" ? "teal" : state === "below" ? "red" : state === "at_risk" ? "amber" : "muted";
  const badge =
    state === "meets" ? "Meets" : state === "below" ? "Below" : state === "at_risk" ? "At risk" : "No data";
  return (
    <div className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-muted">{label}</p>
        <Badge tone={tone}>{badge}</Badge>
      </div>
      <p className="mt-2 text-lg font-bold tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-xs text-ink-muted">{detail}</p>
    </div>
  );
}

export default async function CreatorDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const profile = await requireModule("/creators");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Shim;

  const weekSel = parseWeekSelector(
    typeof searchParams?.week === "string" ? searchParams.week : undefined
  );
  const week = resolveIsoWeek(weekSel);
  const startIso = new Date(week.startUtcMs).toISOString();
  const endIso = new Date(week.endUtcMs).toISOString();

  const [creatorRes, tiersRes, weekPostsRes, everRes, recentRes, dealsRes] = await Promise.all([
    db
      .from("creators")
      .select(
        "id, name, handle, platform, category, status, tier, follower_count, posts_committed, attributed_gmv, owner_id, email"
      )
      .eq("id", params.id)
      .maybeSingle(),
    db
      .from("creator_tiers")
      .select("tier, rank, min_following, max_following, min_gmv, gmv_period, required_post_rate_pct")
      .order("rank"),
    db
      .from("creator_posts")
      .select("id")
      .eq("creator_id", params.id)
      .eq("status", "posted")
      .gte("posted_at", startIso)
      .lt("posted_at", endIso),
    db.from("creator_posts").select("id").eq("creator_id", params.id).eq("status", "posted").limit(1),
    db
      .from("creator_posts")
      .select("id, platform, post_url, posted_at, status, gmv, commission")
      .eq("creator_id", params.id)
      .order("posted_at", { ascending: false })
      .limit(12),
    db
      .from("affiliate_deals")
      .select("id, brand_id, status, gmv_attributed, orders_attributed, start_date, end_date")
      .eq("creator_id", params.id)
      .order("created_at", { ascending: false }),
  ]);

  const creator = creatorRes.data as
    | (StandardCreator & { platform: string; category: string | null; status: string; email: string | null })
    | null;
  if (!creator) notFound();

  const tiers = (tiersRes.data ?? []) as TierRow[];
  const delivered = ((weekPostsRes.data ?? []) as unknown[]).length;
  const hasEverPosted = ((everRes.data ?? []) as unknown[]).length > 0;
  const recent = (recentRes.data ?? []) as Array<{
    id: string;
    platform: string | null;
    post_url: string | null;
    posted_at: string;
    status: string;
    gmv: number | null;
    commission: number | null;
  }>;
  const deals = (dealsRes.data ?? []) as Array<{
    id: string;
    brand_id: string | null;
    status: string;
    gmv_attributed: number | null;
    orders_attributed: number | null;
    start_date: string | null;
    end_date: string | null;
  }>;

  const kpi = computeStandardKpi({ creator, tiers, delivered, hasEverPosted });
  const resolved = resolveTier(creator, tiers);

  // Cadence part state.
  const cadenceState: "meets" | "below" | "at_risk" | "unknown" =
    kpi.committed == null
      ? "unknown"
      : kpi.meetsPostRate
        ? "meets"
        : (kpi.postRatePct ?? 0) >= 80
          ? "at_risk"
          : "below";
  const cadenceValue = kpi.committed == null ? "No commitment" : `${kpi.postRatePct ?? 0}%`;
  const cadenceDetail =
    kpi.committed == null
      ? "No weekly posting commitment set on this creator."
      : `${kpi.delivered}/${kpi.committed} posts this week · bar ${kpi.requiredPostRatePct}%`;

  // GMV part state.
  const gmvState: "meets" | "below" | "at_risk" | "unknown" =
    kpi.meetsGmv == null
      ? "unknown"
      : kpi.meetsGmv
        ? kpi.minGmv != null && kpi.attributedGmv != null && kpi.attributedGmv < kpi.minGmv * 1.2
          ? "at_risk"
          : "meets"
        : "below";
  const gmvValue = kpi.attributedGmv != null ? peso(kpi.attributedGmv) : "—";
  const gmvDetail =
    kpi.minGmv == null
      ? kpi.tierName
        ? `${kpi.tierName} tier sets no GMV floor.`
        : "Untiered — no GMV floor to compare against."
      : `Floor ${peso(kpi.minGmv)} (${kpi.gmvPeriod})`;

  // Follower-band part state.
  const bandState: "meets" | "below" | "at_risk" | "unknown" =
    kpi.followerInBand == null ? "unknown" : kpi.followerInBand ? "meets" : "at_risk";
  const band = resolved?.tier;
  const bandValue = kpi.followerCount != null ? int(kpi.followerCount) : "—";
  const bandDetail = band
    ? `${band.tier} band ${band.min_following != null ? int(band.min_following) : "0"}–${
        band.max_following != null ? int(band.max_following) : "∞"
      }`
    : "Untiered — set a tier or follower count to grade.";

  const weekTab = (sel: "current" | "last", label: string) => (
    <Link
      href={`/creators/${creator.id}${sel === "last" ? "?week=last" : ""}`}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        weekSel === sel
          ? "bg-teal-500/10 text-teal-300"
          : "text-ink-muted hover:bg-charcoal-800 hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );

  const tierBadge = kpi.tierName
    ? `${kpi.tierName}${kpi.tierSource === "band" ? " (by reach)" : ""}`
    : "Untiered";

  return (
    <AppShell breadcrumb={["Mthryve OS", "Creators / Affiliate", creator.name]} profile={profile}>
      <PageHeader
        title={creator.handle ? `${creator.name} · ${creator.handle}` : creator.name}
        subtitle={
          <>
            {creator.platform}
            {creator.category ? ` · ${creator.category}` : ""} · Tier {tierBadge}
          </>
        }
        action={
          <Link
            href="/creators"
            className="rounded-md border border-charcoal-700 px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
          >
            ← All creators
          </Link>
        }
      />

      {/* Overall badge + week toggle */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={verdictTone(kpi.verdict)}>{VERDICT_LABEL[kpi.verdict]}</Badge>
          <span className="text-xs text-ink-muted">
            {week.label} ({week.isoWeek} ·{" "}
            {weekSel === "last" ? "last completed week" : "current week to-date"}, Asia/Manila)
          </span>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-charcoal-700/60 bg-charcoal-900 p-1">
          {weekTab("current", "Current week")}
          {weekTab("last", "Last completed")}
        </div>
      </div>

      {/* Three-part standard */}
      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <PartCard label="Posting cadence" value={cadenceValue} detail={cadenceDetail} state={cadenceState} />
        <PartCard label="Attributed GMV" value={gmvValue} detail={gmvDetail} state={gmvState} />
        <PartCard label="Follower band" value={bandValue} detail={bandDetail} state={bandState} />
      </div>

      {/* Snapshot tiles */}
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Delivered / committed"
          value={kpi.committed != null ? `${kpi.delivered}/${kpi.committed}` : `${kpi.delivered}/—`}
          hint="Posted this ISO week"
        />
        <StatTile
          label="Post rate"
          value={kpi.postRatePct != null ? `${kpi.postRatePct}%` : "—"}
          hint={`Bar ${kpi.requiredPostRatePct}%`}
        />
        <StatTile
          label="Attributed GMV"
          value={kpi.attributedGmv != null ? peso(kpi.attributedGmv) : "—"}
          hint={kpi.minGmv != null ? `Floor ${peso(kpi.minGmv)}` : "No floor"}
        />
        <StatTile
          label="Followers"
          value={kpi.followerCount != null ? int(kpi.followerCount) : "—"}
          hint={kpi.followerInBand == null ? "Untiered" : kpi.followerInBand ? "In band" : "Out of band"}
        />
      </div>

      {/* Vesper Reach — gated outreach drafting */}
      {["ceo", "coo", "department_head"].includes(profile.role) && (
        <SectionCard title="Vesper Reach — draft outreach" className="mb-6">
          <VesperReachPanel
            targetType="creator"
            targetId={creator.id}
            hasEmail={Boolean(creator.email)}
          />
        </SectionCard>
      )}

      {/* Posts backing the weekly rate */}
      <SectionCard title="Recent posts" className="mb-6">
        <TableShell columns={["Posted", "Platform", "Attributed GMV", "Commission", "Status", "Link"]}>
          {recent.length === 0 && (
            <tr>
              <td colSpan={6} className="p-4 text-ink-muted">
                No posts logged yet for this creator.
              </td>
            </tr>
          )}
          {recent.map((p) => (
            <tr key={p.id} className={rowClass}>
              <td className="p-3 text-ink-muted">{manilaStamp(p.posted_at) ?? "—"}</td>
              <td className="p-3 text-ink-muted">{p.platform ?? "—"}</td>
              {/* Attributed GMV / commission render live from the import; an
                  unreported figure is an honest "—", never a fabricated 0. */}
              <td className="p-3 text-ink-muted">{pesoOrDash(p.gmv)}</td>
              <td className="p-3 text-ink-muted">{pesoOrDash(p.commission)}</td>
              <td className="p-3">
                <Badge tone={p.status === "posted" ? "teal" : "muted"}>{p.status}</Badge>
              </td>
              <td className="p-3">
                {safeUrl(p.post_url) ? (
                  <a
                    href={safeUrl(p.post_url)!}
                    target="_blank"
                    rel="noreferrer"
                    className="text-teal-300 hover:underline"
                  >
                    View
                  </a>
                ) : (
                  <span className="text-ink-dim">—</span>
                )}
              </td>
            </tr>
          ))}
        </TableShell>
      </SectionCard>

      {/* Deals context */}
      <SectionCard title="Affiliate deals">
        <TableShell columns={["Status", "GMV attributed", "Orders", "Window"]}>
          {deals.length === 0 && (
            <tr>
              <td colSpan={4} className="p-4 text-ink-muted">
                No affiliate deals for this creator.
              </td>
            </tr>
          )}
          {deals.map((d) => (
            <tr key={d.id} className={rowClass}>
              <td className="p-3">
                <Badge tone={d.status === "active" ? "teal" : d.status === "paused" ? "amber" : "muted"}>
                  {DEAL_STATUS_LABEL[d.status] ?? d.status}
                </Badge>
              </td>
              <td className="p-3 font-mono text-ink">{peso(Number(d.gmv_attributed ?? 0))}</td>
              <td className="p-3 font-mono text-ink-muted">{d.orders_attributed ?? 0}</td>
              <td className="p-3 text-ink-muted">
                {d.start_date ?? "—"} → {d.end_date ?? "—"}
              </td>
            </tr>
          ))}
        </TableShell>
      </SectionCard>
    </AppShell>
  );
}
