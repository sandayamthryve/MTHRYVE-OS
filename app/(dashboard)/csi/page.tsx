import type { ReactNode } from "react";
import Link from "next/link";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, Badge, type BadgeTone } from "@/components/ui";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { manilaStamp } from "@/lib/metrics/windows";
import { safeUrl } from "@/lib/security/sanitize";
import { RunResearchControl } from "./RunResearchControl";

// Agent CSI — Deep Research feed.
//
// Leadership and department heads run grounded research (via the /api/csi/research
// route) and review the findings here. Every card is backed by a real source URL
// captured from a live web_search citation — nothing on this page is fabricated.
// Reads are org-scoped by RLS; status actions (reviewed / dismissed / actioned)
// are gated to leadership and enforced again by RLS on write.

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["ceo", "coo", "department_head"] as const;
const STATUSES = ["new", "reviewed", "actioned", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

type Finding = {
  id: string;
  job_type: string;
  title: string;
  summary: string | null;
  source_url: string;
  source_title: string | null;
  relevance_score: number | null;
  category: string | null;
  status: string;
  brand_id: string | null;
  discovered_at: string | null;
};

const JOB_LABEL: Record<string, string> = {
  trend: "Trend",
  business_opportunity: "Business Opportunity",
};
const JOB_TONE: Record<string, BadgeTone> = {
  trend: "violet",
  business_opportunity: "teal",
};
const STATUS_LABEL: Record<string, string> = {
  new: "New",
  reviewed: "Reviewed",
  actioned: "Actioned",
  dismissed: "Dismissed",
};
const STATUS_TONE: Record<string, BadgeTone> = {
  new: "teal",
  reviewed: "violet",
  actioned: "amber",
  dismissed: "muted",
};

// csi_findings isn't in the generated Database types yet — reach it through the
// same untyped shim the rest of the app uses for not-yet-typed tables.
type UntypedClient = { from: (t: string) => any };
type DbShim = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => { eq: (c: string, val: string) => Promise<unknown> };
  };
};

// ── Server action: change a finding's status (leadership only) ────────────────
// Uses the RLS client as the signed-in leader, so the DB's own write policy is
// the real gate; requireRole is defence in depth. Never a service-role bypass.
async function updateStatus(formData: FormData) {
  "use server";
  await requireRole(["ceo", "coo"]);
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !(STATUSES as readonly string[]).includes(status)) return;
  const supabase = createServerSupabaseClient();
  await (supabase as unknown as DbShim)
    .from("csi_findings")
    .update({ status })
    .eq("id", id);
  revalidatePath("/csi");
}

export default async function CsiPage({
  searchParams,
}: {
  searchParams?: { job_type?: string; status?: string };
}) {
  const profile = await requireRole([...VIEW_ROLES]);
  const isLeadership = profile.role === "ceo" || profile.role === "coo";

  const jobFilter =
    searchParams?.job_type === "trend" || searchParams?.job_type === "business_opportunity"
      ? searchParams.job_type
      : null;
  const statusFilter = (STATUSES as readonly string[]).includes(searchParams?.status ?? "")
    ? (searchParams!.status as Status)
    : null;

  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as UntypedClient;

  // Read the whole (RLS-scoped) feed once, newest first. The KPI tiles count the
  // full set so they stay stable regardless of the active filter; the filters
  // are then applied in memory for the displayed list.
  const [findingsRes, brandsRes] = await Promise.all([
    u
      .from("csi_findings")
      .select(
        "id, job_type, title, summary, source_url, source_title, relevance_score, category, status, brand_id, discovered_at"
      )
      .order("discovered_at", { ascending: false }),
    supabase.from("brands").select("id, name").order("name", { ascending: true }),
  ]);

  const allFindings = (findingsRes.data ?? []) as unknown as Finding[];
  const brands = (brandsRes.data ?? []) as unknown as { id: string; name: string }[];

  const findings = allFindings.filter(
    (f) => (!jobFilter || f.job_type === jobFilter) && (!statusFilter || f.status === statusFilter)
  );

  // KPI tiles count the full feed, not the filtered view.
  const countBy = (s: Status) => allFindings.filter((f) => f.status === s).length;

  // Build a filter href that swaps one param and preserves the other.
  const filterHref = (next: { job_type?: string | null; status?: string | null }) => {
    const params = new URLSearchParams();
    const jt = next.job_type === undefined ? jobFilter : next.job_type;
    const st = next.status === undefined ? statusFilter : next.status;
    if (jt) params.set("job_type", jt);
    if (st) params.set("status", st);
    const qs = params.toString();
    return qs ? `/csi?${qs}` : "/csi";
  };

  const Chip = ({
    active,
    href,
    children,
  }: {
    active: boolean;
    href: string;
    children: ReactNode;
  }) => (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
          : "border-charcoal-700 bg-charcoal-800 text-ink-muted hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );

  return (
    <AppShell breadcrumb={["Mthryve OS", "Agent CSI"]} profile={profile}>
      <PageHeader
        title="Agent CSI — Deep Research"
        subtitle="Grounded, web-sourced intel on trends and opportunities for M-Thryve's PH TikTok Shop & Shopee business. Every finding links to a real source — nothing is fabricated."
      />

      <SectionCard title="Run research" className="mb-6">
        <RunResearchControl brands={brands} />
      </SectionCard>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="New" value={countBy("new")} />
        <StatTile label="Reviewed" value={countBy("reviewed")} />
        <StatTile label="Actioned" value={countBy("actioned")} />
        <StatTile label="Dismissed" value={countBy("dismissed")} />
      </div>

      <div className="mb-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-medium text-ink-dim">Type</span>
          <Chip active={!jobFilter} href={filterHref({ job_type: null })}>
            All
          </Chip>
          <Chip active={jobFilter === "trend"} href={filterHref({ job_type: "trend" })}>
            Trend
          </Chip>
          <Chip
            active={jobFilter === "business_opportunity"}
            href={filterHref({ job_type: "business_opportunity" })}
          >
            Business Opportunity
          </Chip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-medium text-ink-dim">Status</span>
          <Chip active={!statusFilter} href={filterHref({ status: null })}>
            All
          </Chip>
          {STATUSES.map((s) => (
            <Chip key={s} active={statusFilter === s} href={filterHref({ status: s })}>
              {STATUS_LABEL[s]}
            </Chip>
          ))}
        </div>
      </div>

      {findings.length === 0 ? (
        <SectionCard title="Findings">
          <p className="text-sm text-ink-muted">
            {jobFilter || statusFilter
              ? "No findings match these filters yet."
              : "No research findings yet. Run Agent CSI above to gather sourced trends and opportunities."}
          </p>
        </SectionCard>
      ) : (
        <div className="space-y-3">
          {findings.map((f) => {
            const when = manilaStamp(f.discovered_at);
            return (
              <div
                key={f.id}
                className="rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-5 shadow-elevate"
              >
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone={JOB_TONE[f.job_type] ?? "muted"}>
                    {JOB_LABEL[f.job_type] ?? f.job_type}
                  </Badge>
                  <Badge tone={STATUS_TONE[f.status] ?? "muted"}>
                    {STATUS_LABEL[f.status] ?? f.status}
                  </Badge>
                  {f.category ? <Badge tone="muted">{f.category}</Badge> : null}
                  {f.relevance_score != null ? (
                    <span className="font-mono text-[11px] text-ink-muted">
                      Relevance {f.relevance_score}
                    </span>
                  ) : null}
                  <span className="ml-auto font-mono text-[11px] text-ink-dim">
                    {when ? `${when} · Manila` : "—"}
                  </span>
                </div>

                <h3 className="text-base font-semibold text-ink">{f.title}</h3>
                {f.summary ? <p className="mt-1 text-sm text-ink-muted">{f.summary}</p> : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  {safeUrl(f.source_url) ? (
                    <a
                      href={safeUrl(f.source_url)!}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-teal-300 hover:text-teal-200"
                    >
                      {f.source_title || f.source_url}
                      <span aria-hidden>↗</span>
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-sm text-ink-muted">
                      {f.source_title || f.source_url}
                    </span>
                  )}

                  {isLeadership ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {(["reviewed", "actioned", "dismissed"] as const)
                        .filter((s) => s !== f.status)
                        .map((s) => (
                          <form key={s} action={updateStatus}>
                            <input type="hidden" name="id" value={f.id} />
                            <input type="hidden" name="status" value={s} />
                            <button
                              type="submit"
                              className="rounded-md bg-charcoal-800 px-2.5 py-1 text-xs text-ink-muted hover:bg-charcoal-700 hover:text-ink"
                            >
                              Mark {STATUS_LABEL[s].toLowerCase()}
                            </button>
                          </form>
                        ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
