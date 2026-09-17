import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, TableShell, rowClass, Badge } from "@/components/ui";
import { AffiliateTabs } from "@/components/affiliate/AffiliateTabs";
import { computeSampleSla, slaLabel, slaSeverity } from "@/lib/affiliate/sla";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { intOrDash, pesoOrDash, EMPTY } from "@/lib/metrics/format";
import {
  MANAGE_ROLES,
  SAMPLE_TRANSITIONS,
  SAMPLE_STATUS_LABEL,
  sampleStatusTone,
  CONTENT_TRANSITIONS,
  CONTENT_STATUS_LABEL,
  contentStatusTone,
  CONTENT_TYPES,
  type SampleStatus,
  type ContentStatus,
} from "@/lib/affiliate/domain";
import {
  requestSample,
  transitionSample,
  createContent,
  transitionContent,
  updateContentMetrics,
} from "../actions";
import { RowActions } from "@/components/archive/RowActions";
import { ArchivedToggle } from "@/components/archive/ArchivedToggle";
import { rowActionProps } from "@/lib/archive/config";

// SECTION 3 — Fulfillment: the sample pipeline (request → approve → ship →
// delivered → received, reject off-ramp) and the content pipeline (assigned →
// in_progress → submitted → approved → posted/live, reject off-ramp). Each
// forward step stamps the timestamp + acting user the schema carries.
// views/likes/gmv are hand-entered — honest nulls, never a fabricated 0.
export const dynamic = "force-dynamic";

type Db = { from: (t: string) => any };

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";
const miniInput = "w-24 rounded border border-charcoal-700 bg-charcoal-950 p-1 text-[11px] text-ink";

// Human labels for the transition buttons.
const SAMPLE_ACTION_LABEL: Record<SampleStatus, string> = {
  requested: "Request",
  approved: "Approve",
  shipped: "Ship",
  delivered: "Mark delivered",
  received: "Mark received",
  rejected: "Reject",
};
const CONTENT_ACTION_LABEL: Record<ContentStatus, string> = {
  assigned: "Assign",
  in_progress: "Start",
  submitted: "Submit",
  approved: "Approve",
  posted: "Mark posted",
  live: "Mark live",
  rejected: "Reject",
};

function actionTone(to: string): string {
  if (to === "rejected") return "bg-red-500/80 text-white hover:bg-red-500";
  if (to === "approved" || to === "received" || to === "live" || to === "posted" || to === "delivered")
    return "bg-teal-500 text-charcoal-950 hover:bg-teal-400";
  return "bg-charcoal-800 text-ink hover:bg-charcoal-700";
}

export default async function AffiliateFulfillmentPage({
  searchParams,
}: {
  searchParams?: { archived?: string };
}) {
  const profile = await requireModule("/affiliate");
  const supabase = createServerSupabaseClient();
  const db = supabase as unknown as Db;

  // One archive flag drives BOTH the sample and content pipelines: the default
  // view shows active rows, the Archived view shows only archived ones.
  const archived = searchParams?.archived === "1";

  // received_at ships ahead of its migration (20260917040000). PostgREST
  // rejects the WHOLE select if a named column does not exist, and the caller
  // below coalesces a failed read to [] — so asking for it unconditionally would
  // empty the entire sample pipeline on any database that has not run the
  // migration yet, silently, with no error on screen. The fallback keeps every
  // sample visible and costs only the SLA column, which reads "Not received"
  // until the column is really there.
  const SAMPLE_COLUMNS_BASE =
    "id, campaign_id, creator_id, product_id, quantity, status, courier, tracking_number, requested_by, approved_by, requested_at, notes, archived_at";
  const sampleQueryFor = (columns: string) => {
    const query = db.from("affiliate_samples").select(columns).order("requested_at", { ascending: false });
    return archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  };
  const sampleQuery = sampleQueryFor(`${SAMPLE_COLUMNS_BASE}, received_at`);
  const contentQuery = db
    .from("affiliate_content")
    .select("id, campaign_id, creator_id, sample_id, content_type, platform, content_url, status, due_at, posted_at, views, likes, gmv, reviewer_id, created_at, archived_at")
    .order("created_at", { ascending: false });

  const [campaignsRes, creatorsRes, productsRes, samplesRes, contentRes, usersRes] = await Promise.all([
    db.from("op_records").select("id, title").eq("record_type", "campaign").order("created_at", { ascending: false }),
    db.from("creators").select("id, name, handle").order("name"),
    supabase.from("products").select("id, product_name, sku").order("product_name"),
    sampleQuery,
    archived ? contentQuery.not("archived_at", "is", null) : contentQuery.is("archived_at", null),
    supabase.from("users").select("id, full_name"),
  ]);

  // Retry without the column rather than showing an empty pipeline.
  const samplesFallback =
    (samplesRes as { error?: unknown }).error != null
      ? await sampleQueryFor(SAMPLE_COLUMNS_BASE)
      : null;
  const samplesRow = samplesFallback ?? samplesRes;

  const campaigns = (campaignsRes.data ?? []) as { id: string; title: string | null }[];
  const creators = (creatorsRes.data ?? []) as { id: string; name: string | null; handle: string | null }[];
  const products = (productsRes.data ?? []) as { id: string; product_name: string | null; sku: string | null }[];
  const samples = ((samplesRow as { data?: unknown }).data ?? []) as {
    id: string;
    campaign_id: string | null;
    creator_id: string | null;
    product_id: string | null;
    quantity: number | null;
    status: string;
    courier: string | null;
    tracking_number: string | null;
    /** Absent (undefined) on a database that has not run the migration. */
    received_at?: string | null;
    notes: string | null;
    archived_at: string | null;
  }[];
  const content = (contentRes.data ?? []) as {
    id: string;
    campaign_id: string | null;
    creator_id: string | null;
    sample_id: string | null;
    content_type: string | null;
    platform: string | null;
    content_url: string | null;
    status: string;
    posted_at: string | null;
    views: number | null;
    likes: number | null;
    gmv: number | null;
    archived_at: string | null;
  }[];
  const users = (usersRes.data ?? []) as { id: string; full_name: string }[];

  // ── Turnaround SLA (deck slide 9: received → 72h → Video 1 → 48h → Video 2) ─
  // "Video 1" is the earliest content posted against the sample: affiliate_content
  // carries sample_id and posted_at but no ordinal, so posting order IS the order.
  const now = new Date();
  const postedBySample = new Map<string, (string | null)[]>();
  for (const c of content) {
    if (!c.sample_id) continue;
    postedBySample.set(c.sample_id, [...(postedBySample.get(c.sample_id) ?? []), c.posted_at]);
  }
  const slaFor = (sampleId: string, receivedAt: string | null) =>
    computeSampleSla({ receivedAt, postedAt: postedBySample.get(sampleId) ?? [], now });

  // The chase list the Monitoring stage asks for: approaching or already past.
  const chase = samples
    .map((sample) => ({ sample, sla: slaFor(sample.id, sample.received_at ?? null) }))
    .filter((row) => row.sla.state === "overdue" || row.sla.state === "approaching")
    .sort((a, b) => slaSeverity(a.sla) - slaSeverity(b.sla));

  const creatorName = (id: string | null) => (id ? creators.find((c) => c.id === id)?.name ?? "Unknown" : EMPTY);
  const productName = (id: string | null) => (id ? products.find((p) => p.id === id)?.product_name ?? EMPTY : EMPTY);
  const campaignTitle = (id: string | null) => (id ? campaigns.find((c) => c.id === id)?.title ?? EMPTY : EMPTY);

  return (
    <AppShell breadcrumb={["Mthryve OS", "Affiliate", "Fulfillment"]} profile={profile}>
      <PageHeader
        title="Fulfillment"
        subtitle="Product samples and creator content — each moved one guarded step at a time."
      />
      <AffiliateTabs />

      {/* One toggle drives both the sample and content pipelines below. */}
      <div className="mb-6 flex justify-end">
        <ArchivedToggle basePath="/affiliate/fulfillment" archived={archived} />
      </div>

      {/* ── Samples ─────────────────────────────────────────────────────────── */}
      <SectionCard title="Request sample" className="mb-6">
        {creators.length === 0 || products.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Need at least one creator (source under Campaigns) and one product (Warehouse) to request a
            sample.
          </p>
        ) : (
          <form action={requestSample} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <select name="campaign_id" defaultValue="" aria-label="Campaign" className={inputCls}>
              <option value="">Campaign — optional</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.title ?? "Untitled"}</option>
              ))}
            </select>
            <select name="creator_id" required defaultValue="" aria-label="Creator" className={inputCls}>
              <option value="" disabled>Creator…</option>
              {creators.map((c) => (
                <option key={c.id} value={c.id}>{c.name ?? "Unknown"}</option>
              ))}
            </select>
            <select name="product_id" required defaultValue="" aria-label="Product" className={inputCls}>
              <option value="" disabled>Product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.product_name ?? p.sku ?? "Product"}</option>
              ))}
            </select>
            <input name="quantity" type="number" min="1" defaultValue={1} placeholder="Qty" className={inputCls} />
            <input name="notes" placeholder="Notes (optional)" className={`${inputCls} sm:col-span-2 lg:col-span-3`} />
            <button
              type="submit"
              className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Request sample
            </button>
          </form>
        )}
      </SectionCard>

      {/* Monitoring: "follow up proactively with creators who are approaching or
          past their SLA" — so this lists both, worst first, rather than waiting
          for a breach. */}
      {chase.length > 0 && (
        <SectionCard title={`Chase list (${chase.length})`} className="mb-8">
          <div className="space-y-2">
            {chase.map(({ sample, sla }) => (
              <div
                key={sample.id}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 ${
                  sla.state === "overdue"
                    ? "border-red-500/30 bg-red-500/5"
                    : "border-amber-500/30 bg-amber-500/5"
                }`}
              >
                <span className="min-w-0 text-sm text-ink">
                  {creatorName(sample.creator_id)}
                  <span className="text-ink-muted"> · {productName(sample.product_id)}</span>
                </span>
                <Badge tone={sla.tone}>{slaLabel(sla)}</Badge>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard title="Sample pipeline" className="mb-8" bodyClassName="p-0">
        {samples.length === 0 ? (
          <p className="p-5 text-sm text-ink-muted">No samples requested yet.</p>
        ) : (
          <TableShell columns={["Creator", "Product", "Campaign", "Qty", "Status", "Turnaround SLA", "Courier / Tracking", "Actions", "Manage"]}>
            {samples.map((s) => {
              const nexts = SAMPLE_TRANSITIONS[s.status as SampleStatus] ?? [];
              const sla = slaFor(s.id, s.received_at ?? null);
              return (
                <tr key={s.id} className={rowClass}>
                  <td className="p-3 font-medium text-ink">{creatorName(s.creator_id)}</td>
                  <td className="p-3 text-ink-muted">{productName(s.product_id)}</td>
                  <td className="p-3 text-ink-muted">{campaignTitle(s.campaign_id)}</td>
                  <td className="p-3 font-mono text-ink">{intOrDash(s.quantity)}</td>
                  <td className="p-3">
                    <Badge tone={sampleStatusTone(s.status)}>
                      {SAMPLE_STATUS_LABEL[s.status as SampleStatus] ?? s.status}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Badge tone={sla.tone}>{slaLabel(sla)}</Badge>
                  </td>
                  <td className="p-3 text-xs text-ink-muted">
                    {s.courier || s.tracking_number ? (
                      <span>
                        {s.courier ?? EMPTY} · <span className="font-mono">{s.tracking_number ?? EMPTY}</span>
                      </span>
                    ) : (
                      EMPTY
                    )}
                  </td>
                  <td className="p-3">
                    {nexts.length === 0 ? (
                      <span className="text-[11px] text-ink-dim">—</span>
                    ) : (
                      <div className="flex flex-wrap items-start gap-2">
                        {nexts.map((to) =>
                          to === "shipped" ? (
                            <form key={to} action={transitionSample} className="flex flex-wrap items-center gap-1">
                              <input type="hidden" name="id" value={s.id} />
                              <input type="hidden" name="to" value="shipped" />
                              <input name="courier" placeholder="Courier" className={miniInput} />
                              <input name="tracking_number" placeholder="Tracking #" className={miniInput} />
                              <button type="submit" className={`rounded px-2 py-1 text-[11px] font-semibold ${actionTone(to)}`}>
                                {SAMPLE_ACTION_LABEL[to]}
                              </button>
                            </form>
                          ) : (
                            <form key={to} action={transitionSample}>
                              <input type="hidden" name="id" value={s.id} />
                              <input type="hidden" name="to" value={to} />
                              <button type="submit" className={`rounded px-2 py-1 text-[11px] font-semibold ${actionTone(to)}`}>
                                {SAMPLE_ACTION_LABEL[to]}
                              </button>
                            </form>
                          )
                        )}
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <RowActions {...rowActionProps("affiliate_samples", s as unknown as Record<string, unknown>, profile)} />
                  </td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </SectionCard>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <SectionCard title="Assign content" className="mb-6">
        {creators.length === 0 ? (
          <p className="text-sm text-ink-muted">Source a creator under Campaigns first.</p>
        ) : (
          <form action={createContent} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <select name="campaign_id" defaultValue="" aria-label="Campaign" className={inputCls}>
              <option value="">Campaign — optional</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.title ?? "Untitled"}</option>
              ))}
            </select>
            <select name="creator_id" required defaultValue="" aria-label="Creator" className={inputCls}>
              <option value="" disabled>Creator…</option>
              {creators.map((c) => (
                <option key={c.id} value={c.id}>{c.name ?? "Unknown"}</option>
              ))}
            </select>
            <select name="content_type" required defaultValue="video" aria-label="Content type" className={inputCls}>
              {CONTENT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select name="sample_id" defaultValue="" aria-label="Linked sample" className={inputCls}>
              <option value="">Link sample — optional</option>
              {samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {creatorName(s.creator_id)} · {productName(s.product_id)}
                </option>
              ))}
            </select>
            <input name="platform" placeholder="Platform (e.g. TikTok)" className={inputCls} />
            <input name="content_url" placeholder="Content URL (optional)" className={inputCls} />
            <label className="text-xs text-ink-muted">
              Due
              <input name="due_at" type="datetime-local" className={`mt-1 w-full ${inputCls}`} />
            </label>
            <button
              type="submit"
              className="self-end rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400"
            >
              Assign content
            </button>
          </form>
        )}
      </SectionCard>

      <SectionCard title="Content pipeline" bodyClassName="p-0">
        {content.length === 0 ? (
          <p className="p-5 text-sm text-ink-muted">No content assigned yet.</p>
        ) : (
          <TableShell columns={["Creator", "Type", "Status", "URL", "Views", "Likes", "GMV", "Actions", "Manage"]}>
            {content.map((c) => {
              const nexts = CONTENT_TRANSITIONS[c.status as ContentStatus] ?? [];
              return (
                <tr key={c.id} className={rowClass}>
                  <td className="p-3 font-medium text-ink">{creatorName(c.creator_id)}</td>
                  <td className="p-3 text-ink-muted">
                    {c.content_type ?? EMPTY}
                    {c.platform ? <span className="text-ink-dim"> · {c.platform}</span> : null}
                  </td>
                  <td className="p-3">
                    <Badge tone={contentStatusTone(c.status)}>
                      {CONTENT_STATUS_LABEL[c.status as ContentStatus] ?? c.status}
                    </Badge>
                  </td>
                  <td className="p-3 max-w-[10rem] truncate text-xs">
                    {c.content_url ? (
                      <Link href={c.content_url} target="_blank" className="text-teal-300 hover:underline">
                        link ↗
                      </Link>
                    ) : (
                      <span className="text-ink-dim">{EMPTY}</span>
                    )}
                  </td>
                  <td className="p-3 font-mono text-ink">{intOrDash(c.views)}</td>
                  <td className="p-3 font-mono text-ink">{intOrDash(c.likes)}</td>
                  <td className="p-3 font-mono text-ink">{pesoOrDash(c.gmv)}</td>
                  <td className="p-3">
                    <div className="flex flex-col gap-2">
                      {/* Transitions */}
                      <div className="flex flex-wrap items-center gap-2">
                        {nexts.length === 0 ? (
                          <span className="text-[11px] text-ink-dim">—</span>
                        ) : (
                          nexts.map((to) =>
                            to === "submitted" ? (
                              <form key={to} action={transitionContent} className="flex items-center gap-1">
                                <input type="hidden" name="id" value={c.id} />
                                <input type="hidden" name="to" value="submitted" />
                                <input name="content_url" placeholder="URL" className={miniInput} />
                                <button type="submit" className={`rounded px-2 py-1 text-[11px] font-semibold ${actionTone(to)}`}>
                                  {CONTENT_ACTION_LABEL[to]}
                                </button>
                              </form>
                            ) : (
                              <form key={to} action={transitionContent}>
                                <input type="hidden" name="id" value={c.id} />
                                <input type="hidden" name="to" value={to} />
                                <button type="submit" className={`rounded px-2 py-1 text-[11px] font-semibold ${actionTone(to)}`}>
                                  {CONTENT_ACTION_LABEL[to]}
                                </button>
                              </form>
                            )
                          )
                        )}
                      </div>
                      {/* Manual metrics — honest nulls; blank inputs leave values untouched */}
                      <form action={updateContentMetrics} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="id" value={c.id} />
                        <input name="views" type="number" min="0" placeholder="views" className={miniInput} />
                        <input name="likes" type="number" min="0" placeholder="likes" className={miniInput} />
                        <input name="gmv" type="number" min="0" step="0.01" placeholder="gmv" className={miniInput} />
                        <button type="submit" className="rounded bg-charcoal-800 px-2 py-1 text-[11px] text-ink hover:bg-charcoal-700">
                          Save
                        </button>
                      </form>
                    </div>
                  </td>
                  <td className="p-3">
                    <RowActions {...rowActionProps("affiliate_content", c as unknown as Record<string, unknown>, profile)} />
                  </td>
                </tr>
              );
            })}
          </TableShell>
        )}
        <p className="border-t border-charcoal-700/60 p-3 text-[11px] text-ink-dim">
          Views, likes and GMV are hand-entered — a blank stays “—”, never a fabricated 0. Approve /
          reject stamp the reviewer; each ship captures courier + tracking.
        </p>
      </SectionCard>
    </AppShell>
  );
}
