import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, Badge, TableShell, rowClass, type BadgeTone } from "@/components/ui";
import { LiveOpsTabs } from "@/components/live-ops/LiveOpsTabs";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manilaStamp } from "@/lib/metrics/windows";
import { hoursOrDash, sessionHours, type LiveSession } from "@/lib/metrics/live";
import {
  REPORT_FIELDS_BY_GROUP,
  LANE_LABEL,
  LANE_TONE,
  originOf,
  type ReportField,
} from "@/lib/live-ops/fields";
import {
  BOTTLENECK_CATEGORIES,
  CATEGORY_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  type LiveBottleneck,
} from "@/lib/live-ops/bottlenecks";
import type { BriefPayload } from "@/lib/briefings/account-review";
import {
  updateLiveReport,
  submitLiveReport,
  reviewLiveReport,
  deleteLiveReport,
  addBottleneck,
  addAttachment,
  deleteAttachment,
  generateLiveAiBrief,
  routeRecommendation,
} from "../../actions";

// PART C/D — The Daily Live Report editor for one session.
//
// Header auto-computes Total Live Hours from start/end. The standard-metrics
// section is HYBRID: each field shows its origin (API-ready vs Manual) and the
// row's provenance (source). A manual save never silently overwrites a synced
// 'api' value — a divergence is flagged. Session Assessment writes the
// qualitative jsonb; challenges are categorized into live_bottlenecks. On
// submit, Claude analyzes quant + qual into an AI brief whose recommendations
// route to PENDING approval.

export const dynamic = "force-dynamic";

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2 text-sm text-ink w-full";
const REPORT_STATUS_TONE: Record<string, BadgeTone> = { draft: "muted", submitted: "violet", reviewed: "teal" };

type Brand = { id: string; name: string };
type Anchor = { id: string; name: string };
type Person = { id: string; full_name: string };

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  // Render the stored instant in Asia/Manila for the datetime-local control.
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return "";
  }
}

function MetricInput({ f, session }: { f: ReportField; session: LiveSession }) {
  const v = (session as unknown as Record<string, unknown>)[f.key];
  const step = f.kind === "int" ? "1" : "any";
  const type = f.kind === "text" ? "text" : "number";
  return (
    <label className="block">
      <span className="flex items-center justify-between gap-1">
        <span className="text-[10px] uppercase tracking-wider text-ink-muted">{f.label}</span>
        <Badge tone={LANE_TONE[f.lane]}>{LANE_LABEL[f.lane]}</Badge>
      </span>
      <input
        name={f.key}
        type={type}
        step={type === "number" ? step : undefined}
        defaultValue={v == null ? "" : String(v)}
        className={`${inputCls} mt-1`}
      />
      {f.hint ? <span className="mt-0.5 block text-[10px] text-ink-dim">{f.hint}</span> : null}
    </label>
  );
}

export default async function ReportDetail({ params }: { params: { id: string } }) {
  const profile = await requireModule("/live-ops");
  const isLead = ["ceo", "coo", "department_head"].includes(profile.role);
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const { data: sessionRow } = await u.from("live_sessions").select("*").eq("id", params.id).maybeSingle();
  if (!sessionRow) notFound();
  const session = sessionRow as LiveSession;

  const [brandsRes, anchorsRes, usersRes, attachRes, bottleRes, briefRes] = await Promise.all([
    supabase.from("brands").select("id, name").order("name"),
    u.from("anchors").select("id, name").order("name"),
    supabase.from("users").select("id, full_name").order("full_name"),
    u.from("live_session_attachments").select("*").eq("session_id", params.id).order("created_at", { ascending: false }),
    u.from("live_bottlenecks").select("*").eq("session_id", params.id).order("created_at", { ascending: false }),
    u.from("account_review_briefs").select("id, payload, created_at").eq("department", "Live Operations").order("created_at", { ascending: false }).limit(50),
  ]);

  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const anchors = (anchorsRes.data ?? []) as Anchor[];
  const people = (usersRes.data ?? []) as unknown as Person[];
  const attachments = (attachRes.data ?? []) as { id: string; url: string; kind: string | null; created_at: string }[];
  const bottlenecks = (bottleRes.data ?? []) as LiveBottleneck[];

  // Latest AI brief for THIS session (filtered from the recent Live Ops briefs).
  const briefs = (briefRes.data ?? []) as { id: string; payload: BriefPayload & { scope?: { session_id?: string } }; created_at: string }[];
  const brief = briefs.find((b) => b.payload?.scope?.session_id === params.id) ?? null;

  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const anchorName = (id: string | null) => anchors.find((a) => a.id === id)?.name ?? "—";
  const personName = (id: string | null) => people.find((p) => p.id === id)?.full_name ?? "—";

  const origin = originOf(session.source);
  const assessment = (session.assessment ?? {}) as Record<string, unknown>;
  const divergence = (assessment._divergence ?? null) as Record<string, { api: unknown; manual: unknown }> | null;
  const hrs = sessionHours(session);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Operations", "Daily Reports", session.title ?? "Report"]} profile={profile}>
      <PageHeader
        title={session.title ?? "Untitled live"}
        subtitle={`${brandName(session.brand_id)} · ${anchorName(session.anchor_id)} · ${manilaStamp(session.started_at) ?? "no start recorded"}`}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={REPORT_STATUS_TONE[session.report_status] ?? "muted"}>{session.report_status}</Badge>
            <Badge tone={origin === "api" ? "teal" : "muted"}>source · {session.source}</Badge>
          </div>
        }
      />
      <LiveOpsTabs />

      <div className="mb-4">
        <Link href="/live-ops/reports" className="text-xs text-ink-muted hover:text-ink">← All reports</Link>
      </div>

      {divergence && Object.keys(divergence).length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-4">
          <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-amber-300">⚠ Divergence from API</p>
          <p className="text-xs text-ink-muted">
            A manual edit changed values that were synced from the platform. The API snapshot is preserved; these fields now differ:
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-ink">
            {Object.entries(divergence).map(([k, d]) => (
              <li key={k} className="font-mono">{k}: api={String(d.api)} → manual={String(d.manual)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Session Information (header) — auto Total Live Hours ── */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Total live hours" value={hoursOrDash(hrs)} hint="from start / end" valueClassName="text-teal-300" />
        <StatTile label="Studio" value={session.studio ?? "—"} valueClassName="text-sm" />
        <StatTile label="Shift" value={session.shift ?? "—"} valueClassName="text-sm" />
        <StatTile label="Moderator" value={personName(session.moderator_id)} valueClassName="text-sm" />
        <StatTile label="Team leader" value={personName(session.team_leader_id)} valueClassName="text-sm" />
        <StatTile label="Featured" value={session.featured_products ?? "—"} valueClassName="text-sm" />
      </div>

      {/* ── The editor: header + hybrid metrics + assessment (one save) ── */}
      <form action={updateLiveReport} className="mb-6">
        <input type="hidden" name="id" value={session.id} />

        <SectionCard title="Session Information" className="mb-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="title" defaultValue={session.title ?? ""} placeholder="Session title" className={`${inputCls} sm:col-span-2`} />
            <input name="session_number" defaultValue={session.session_number ?? ""} placeholder="Session #" className={inputCls} />
            <select name="brand_id" defaultValue={session.brand_id ?? ""} className={inputCls}>
              <option value="">Brand…</option>
              {brands.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
            </select>
            <select name="anchor_id" defaultValue={session.anchor_id ?? ""} className={inputCls}>
              <option value="">Anchor…</option>
              {anchors.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
            </select>
            <select name="platform" defaultValue={session.platform} className={inputCls}>
              <option value="tiktok_shop">TikTok Shop</option>
              <option value="tiktok">TikTok</option>
              <option value="shopee">Shopee</option>
              <option value="lazada">Lazada</option>
            </select>
            <select name="moderator_id" defaultValue={session.moderator_id ?? ""} className={inputCls}>
              <option value="">Moderator…</option>
              {people.map((p) => (<option key={p.id} value={p.id}>{p.full_name}</option>))}
            </select>
            <select name="team_leader_id" defaultValue={session.team_leader_id ?? ""} className={inputCls}>
              <option value="">Team leader…</option>
              {people.map((p) => (<option key={p.id} value={p.id}>{p.full_name}</option>))}
            </select>
            <input name="studio" defaultValue={session.studio ?? ""} placeholder="Studio" className={inputCls} />
            <input name="shift" defaultValue={session.shift ?? ""} placeholder="Shift" className={inputCls} />
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Started
              <input type="datetime-local" name="started_at" defaultValue={toLocalInput(session.started_at)} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Ended
              <input type="datetime-local" name="ended_at" defaultValue={toLocalInput(session.ended_at)} className={`${inputCls} mt-1`} />
            </label>
            <input name="duration_minutes" type="number" defaultValue={session.duration_minutes ?? ""} placeholder="Duration (min)" className={inputCls} />
            <input name="expected_duration_minutes" type="number" defaultValue={session.expected_duration_minutes ?? ""} placeholder="Expected duration (min)" className={inputCls} />
            <input name="featured_products" defaultValue={session.featured_products ?? ""} placeholder="Featured products" className={`${inputCls} sm:col-span-3`} />
          </div>
        </SectionCard>

        <SectionCard title="Standard metrics" action={<Badge tone="muted">Hybrid · origin per field</Badge>} className="mb-4">
          <p className="mb-3 text-xs text-ink-muted">
            Auto-fills from the platform API where it can deliver; otherwise the anchor encodes. TikTok exposes almost nothing at live-session granularity, so most fields are hand-entered. Blank stays “—”.
          </p>
          <div className="mb-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-gold-400">Sales</p>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {REPORT_FIELDS_BY_GROUP.sales.map((f) => (<MetricInput key={f.key} f={f} session={session} />))}
            </div>
          </div>
          <div className="mb-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-teal-300">Audience</p>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {REPORT_FIELDS_BY_GROUP.audience.map((f) => (<MetricInput key={f.key} f={f} session={session} />))}
            </div>
          </div>
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-violet-300">Engagement</p>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {REPORT_FIELDS_BY_GROUP.engagement.map((f) => (<MetricInput key={f.key} f={f} session={session} />))}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Session Assessment" action={<Badge tone="muted">Qualitative</Badge>} className="mb-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Highlights
              <textarea name="assessment_highlights" defaultValue={(assessment.highlights as string) ?? ""} rows={3} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Challenges
              <textarea name="assessment_challenges" defaultValue={(assessment.challenges as string) ?? ""} rows={3} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Customer insights
              <textarea name="assessment_customer_insights" defaultValue={(assessment.customer_insights as string) ?? ""} rows={3} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted">
              Competitor observations
              <textarea name="assessment_competitor_obs" defaultValue={(assessment.competitor_obs as string) ?? ""} rows={3} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-ink-muted sm:col-span-2">
              Notes
              <textarea name="notes" defaultValue={session.notes ?? ""} rows={2} className={`${inputCls} mt-1`} />
            </label>
          </div>
        </SectionCard>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400">Save report</button>
        </div>
      </form>

      {/* ── Lifecycle: submit / review ── */}
      <SectionCard title="Report lifecycle" className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={REPORT_STATUS_TONE[session.report_status] ?? "muted"}>{session.report_status}</Badge>
          {session.report_status === "draft" && (
            <form action={submitLiveReport}>
              <input type="hidden" name="id" value={session.id} />
              <button type="submit" className="rounded-md bg-violet-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-violet-400">Submit for review</button>
            </form>
          )}
          {session.report_status === "submitted" && isLead && (
            <form action={reviewLiveReport}>
              <input type="hidden" name="id" value={session.id} />
              <button type="submit" className="rounded-md bg-teal-500 px-3 py-1.5 text-xs font-semibold text-charcoal-950 hover:bg-teal-400">Mark reviewed</button>
            </form>
          )}
          {session.report_status === "submitted" && !isLead && (
            <span className="text-xs text-ink-muted">Awaiting leadership review.</span>
          )}
          <span className="text-[11px] text-ink-dim">
            {session.report_submitted_at ? `Submitted ${manilaStamp(session.report_submitted_at)}` : ""}
            {session.report_reviewed_at ? ` · Reviewed ${manilaStamp(session.report_reviewed_at)}` : ""}
          </span>
          {isLead && (
            <form action={deleteLiveReport} className="ml-auto">
              <input type="hidden" name="id" value={session.id} />
              <button type="submit" className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs text-red-300 hover:bg-charcoal-700">Delete report</button>
            </form>
          )}
        </div>
      </SectionCard>

      {/* ── Bottlenecks reported on this session ── */}
      <SectionCard title="Reported bottlenecks" action={<Badge tone="muted">{bottlenecks.length}</Badge>} className="mb-6">
        {bottlenecks.length === 0 ? (
          <p className="mb-3 text-xs text-ink-muted">No bottlenecks categorized yet. Add each reported challenge below so it routes to the Bottleneck dashboard.</p>
        ) : (
          <div className="mb-4">
            <TableShell columns={["Category", "Severity", "Note", "Status", "Assigned"]}>
              {bottlenecks.map((b) => (
                <tr key={b.id} className={rowClass}>
                  <td className="p-3 text-ink">{CATEGORY_LABEL[b.category] ?? b.category}</td>
                  <td className="p-3"><Badge tone={SEVERITY_TONE[b.severity]}>{SEVERITY_LABEL[b.severity]}</Badge></td>
                  <td className="p-3 text-ink-muted">{b.note ?? "—"}</td>
                  <td className="p-3"><Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge></td>
                  <td className="p-3 text-ink-muted">{b.assigned_dept ?? "—"}</td>
                </tr>
              ))}
            </TableShell>
          </div>
        )}
        <form action={addBottleneck} className="grid gap-3 sm:grid-cols-4">
          <input type="hidden" name="session_id" value={session.id} />
          <select name="category" defaultValue="" required className={inputCls}>
            <option value="" disabled>Category…</option>
            {BOTTLENECK_CATEGORIES.map((c) => (<option key={c} value={c}>{CATEGORY_LABEL[c]}</option>))}
          </select>
          <select name="severity" defaultValue="medium" className={inputCls}>
            {SEVERITIES.map((s) => (<option key={s} value={s}>{SEVERITY_LABEL[s]}</option>))}
          </select>
          <input name="note" placeholder="What happened?" className={`${inputCls} sm:col-span-2`} />
          <button type="submit" className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:col-span-4 sm:w-auto sm:justify-self-start">Add bottleneck</button>
        </form>
      </SectionCard>

      {/* ── Attachments ── */}
      <SectionCard title="Attachments" action={<Badge tone="muted">{attachments.length}</Badge>} className="mb-6">
        {attachments.length > 0 && (
          <ul className="mb-3 space-y-1">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-ink">
                  <Badge tone="muted">{a.kind ?? "file"}</Badge>{" "}
                  {/^https?:\/\//i.test(a.url) ? (
                    <a href={a.url} target="_blank" rel="noreferrer" className="text-teal-300 hover:text-teal-200">{a.url}</a>
                  ) : (
                    <span className="font-mono text-ink-muted">{a.url.split("/").pop()}</span>
                  )}
                </span>
                <form action={deleteAttachment}>
                  <input type="hidden" name="id" value={a.id} />
                  <input type="hidden" name="session_id" value={session.id} />
                  <button type="submit" className="rounded-md bg-charcoal-800 px-2 py-1 text-[11px] text-red-300 hover:bg-charcoal-700">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <form action={addAttachment} className="grid gap-3 sm:grid-cols-4">
          <input type="hidden" name="session_id" value={session.id} />
          <input type="file" name="file" className={`${inputCls} sm:col-span-2`} />
          <input name="link" placeholder="…or paste a link" className={inputCls} />
          <input name="kind" placeholder="Kind (optional)" className={inputCls} />
          <button type="submit" className="rounded-md bg-charcoal-800 px-3 py-2 text-xs font-semibold text-teal-300 hover:bg-charcoal-700 sm:col-span-4 sm:w-auto sm:justify-self-start">Attach</button>
        </form>
      </SectionCard>

      {/* ── Claude AI brief ── */}
      <SectionCard
        title="Claude AI brief"
        action={
          isLead ? (
            <form action={generateLiveAiBrief}>
              <input type="hidden" name="session_id" value={session.id} />
              <button type="submit" className="rounded-md bg-charcoal-800 px-3 py-1.5 text-xs font-semibold text-teal-300 hover:bg-charcoal-700">
                {brief ? "Regenerate" : "Generate brief"}
              </button>
            </form>
          ) : undefined
        }
      >
        {!brief ? (
          <p className="text-xs text-ink-muted">
            No AI brief yet. It generates automatically when the report is submitted; leadership can also generate it on demand. The brief grounds Claude on this session's real numbers + assessment — nothing is fabricated.
          </p>
        ) : (
          <BriefView brief={brief.payload} briefId={brief.id} sessionId={session.id} isLead={isLead} />
        )}
      </SectionCard>
    </AppShell>
  );
}

// The persisted BriefPayload rendered read-only, with a leadership "Send to
// approval" per recommendation (stages a PENDING action_request — nothing runs).
function BriefView({
  brief,
  briefId,
  sessionId,
  isLead,
}: {
  brief: BriefPayload;
  briefId: string;
  sessionId: string;
  isLead: boolean;
}) {
  const op = brief.overall_performance;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={brief.meta.grounded ? "teal" : "amber"}>{brief.meta.grounded ? "Grounded" : "Insufficient data"}</Badge>
        {brief.meta.model && <Badge tone="muted">{brief.meta.model}</Badge>}
        <Badge tone="muted">{brief.meta.metrics_with_data}/{brief.meta.metrics_total} KPIs</Badge>
      </div>
      <p className="text-sm text-ink">{brief.executive_summary}</p>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { k: "Sales", v: op.sales_trend },
          { k: "Traffic", v: op.traffic_trend },
          { k: "Conversion", v: op.conversion_trend },
          { k: "Operations", v: op.operational_efficiency },
        ].map((x) => (
          <div key={x.k} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3">
            <p className="font-mono text-[9px] uppercase tracking-wider text-ink-dim">{x.k}</p>
            <p className="mt-1 text-xs text-ink">{x.v}</p>
          </div>
        ))}
      </div>

      {brief.highlights.length > 0 && (
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-teal-300">Highlights</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink">{brief.highlights.map((h, i) => (<li key={i}>{h}</li>))}</ul>
        </div>
      )}
      {brief.concerns.length > 0 && (
        <div>
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-amber-300">Concerns / root cause</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink">{brief.concerns.map((c, i) => (<li key={i}>{c}</li>))}</ul>
        </div>
      )}

      {brief.recommendations.length > 0 && (
        <div>
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-violet-300">Recommendations (route to approval — nothing auto-executes)</p>
          <ul className="space-y-2">
            {brief.recommendations.map((r, i) => (
              <li key={i} className="rounded-lg border border-charcoal-700/60 bg-charcoal-950/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-ink">{r.action}</p>
                    {r.rationale && <p className="mt-0.5 text-xs text-ink-muted">{r.rationale}</p>}
                    <div className="mt-1 flex items-center gap-2">
                      <Badge tone={r.priority === "high" ? "red" : r.priority === "medium" ? "amber" : "muted"}>{r.priority}</Badge>
                      <Badge tone="muted">→ {r.target_department}</Badge>
                    </div>
                  </div>
                  {isLead && (
                    <form action={routeRecommendation}>
                      <input type="hidden" name="brief_id" value={briefId} />
                      <input type="hidden" name="recommendation_index" value={i} />
                      <input type="hidden" name="session_id" value={sessionId} />
                      <button type="submit" className="shrink-0 rounded-md bg-teal-500 px-3 py-1.5 text-[11px] font-semibold text-charcoal-950 hover:bg-teal-400">Send to approval</button>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
