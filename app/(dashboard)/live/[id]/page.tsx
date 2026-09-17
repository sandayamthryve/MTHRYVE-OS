import { requireModule } from "@/lib/auth/session";
import { ModuleLink as Link } from "@/components/layout/ModuleAccessProvider";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader, SectionCard, StatTile, Badge, type BadgeTone } from "@/components/ui";
import { Funnel } from "@/components/live/Funnel";
import { DemographicsChart } from "@/components/live/DemographicsChart";
import { ElapsedTime } from "@/components/live/ElapsedTime";
import { requireRole } from "@/lib/auth/session";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { manilaStamp } from "@/lib/metrics/windows";
import { peso, pesoOrDash, intOrDash } from "@/lib/metrics/format";
import {
  sessionCtr,
  sessionCtor,
  sessionHours,
  elapsedSeconds,
  rollupDemographics,
  ratePct,
  hoursOrDash,
  type Anchor,
  type LiveSession,
} from "@/lib/metrics/live";
import { updateSession, deleteSession } from "../actions";

// Session detail — the funnel (impressions → clicks → orders), GMV, audience
// demographics and the full session editor for one live session. Org/RLS-scoped:
// the row only loads if it belongs to the caller's org. Every figure is real;
// unrecorded metrics read as an em-dash, and the funnel/demographics show honest
// empty states until counts are entered.

export const dynamic = "force-dynamic";

const SESSION_STATUSES = ["scheduled", "live", "ended"] as const;
const SESSION_STATUS_LABEL: Record<string, string> = { scheduled: "Scheduled", live: "Live", ended: "Ended" };
const SESSION_STATUS_TONE: Record<string, BadgeTone> = { scheduled: "violet", live: "red", ended: "muted" };

const PLATFORMS = [
  { value: "tiktok_shop", label: "TikTok Shop" },
  { value: "tiktok", label: "TikTok" },
  { value: "shopee", label: "Shopee" },
  { value: "lazada", label: "Lazada" },
];

const inputCls = "rounded-md border border-charcoal-700 bg-charcoal-950 p-2.5 text-sm text-ink";

type Brand = { id: string; name: string };

// ISO → "YYYY-MM-DDTHH:mm" in Asia/Manila for a datetime-local default, so the
// editor shows the same wall-clock the actions layer writes back.
function toManilaInput(iso: string | null): string {
  if (!iso) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hh = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}-${get("month")}-${get("day")}T${hh}:${get("minute")}`;
  } catch {
    return "";
  }
}

// Reconstruct a "bucket:weight, bucket:weight" string from a stored facet map so
// the editor can round-trip demographics.
function demoToText(map: Record<string, number> | null | undefined): string {
  if (!map) return "";
  return Object.entries(map)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

export default async function LiveSessionDetailPage({ params }: { params: { id: string } }) {
  const profile = await requireModule("/live");
  const supabase = createServerSupabaseClient();
  const u = supabase as unknown as { from: (t: string) => any };

  const [sessionRes, brandsRes, anchorsRes] = await Promise.all([
    u.from("live_sessions").select("*").eq("id", params.id).maybeSingle(),
    supabase.from("brands").select("id, name").order("name"),
    u.from("anchors").select("*").order("name"),
  ]);

  const s = sessionRes.data as LiveSession | null;
  if (!s) notFound();

  const brands = (brandsRes.data ?? []) as unknown as Brand[];
  const anchors = (anchorsRes.data ?? []) as Anchor[];
  const brandName = (id: string | null) => brands.find((b) => b.id === id)?.name ?? "—";
  const anchorName = (id: string | null) => anchors.find((a) => a.id === id)?.name ?? "—";

  const ctr = sessionCtr(s);
  const ctor = sessionCtor(s);
  const hrs = sessionHours(s);
  const demo = rollupDemographics([s]);
  const elapsed = elapsedSeconds(s);
  const demoAge = (s.demographics?.age ?? null) as Record<string, number> | null;
  const demoGender = (s.demographics?.gender ?? null) as Record<string, number> | null;
  const demoLocation = (s.demographics?.location ?? null) as Record<string, number> | null;

  return (
    <AppShell breadcrumb={["Mthryve OS", "Live Selling", s.title ?? "Session"]} profile={profile}>
      <div className="mb-4">
        <Link href="/live" className="text-xs text-ink-muted hover:text-teal-300">← Back to Live Selling</Link>
      </div>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {s.title ?? "Untitled live"}
            <Badge tone={SESSION_STATUS_TONE[s.status] ?? "muted"}>{SESSION_STATUS_LABEL[s.status] ?? s.status}</Badge>
            {s.source === "api" && <Badge tone="teal">API</Badge>}
          </span>
        }
        subtitle={`${brandName(s.brand_id)} · ${anchorName(s.anchor_id)}`}
      />

      {/* Date / time + live elapsed */}
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-charcoal-700/60 bg-charcoal-900 p-4 font-mono text-xs text-ink-muted shadow-elevate">
        <span>Started <span className="text-ink">{manilaStamp(s.started_at) ?? "—"}</span></span>
        <span>Ended <span className="text-ink">{manilaStamp(s.ended_at) ?? "—"}</span></span>
        <span>Live hours <span className="text-ink">{hoursOrDash(hrs)}</span></span>
        {s.status === "live" && s.started_at && (
          <span className="inline-flex items-center gap-2 text-red-300">
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" /> Live for
            <ElapsedTime startedAt={s.started_at} seedSeconds={elapsed ?? 0} className="text-ink" />
          </span>
        )}
      </div>

      {/* Headline metrics */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="GMV" value={pesoOrDash(s.gmv)} valueClassName="text-gold-400" />
        <StatTile label="Attributed GMV" value={pesoOrDash(s.attributed_gmv)} hint="attributed to live" />
        <StatTile label="Units sold" value={intOrDash(s.units_sold)} />
        <StatTile label="Products sold" value={intOrDash(s.products_sold)} />
        <StatTile label="CTR" value={ratePct(ctr.value)} hint={ctr.computed ? "clicks / impressions" : "stored rate"} />
        <StatTile label="CTOR" value={ratePct(ctor.value)} hint={ctor.computed ? "orders / clicks" : "stored rate"} />
        <StatTile label="Peak viewers" value={intOrDash(s.peak_viewers)} />
        <StatTile label="Avg viewers" value={intOrDash(s.avg_viewers)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Conversion funnel">
          <p className="mb-4 text-xs text-ink-muted">Impressions → clicks → orders, with the guarded CTR and CTOR between stages.</p>
          <Funnel
            impressions={s.impressions}
            clicks={s.clicks}
            orders={s.orders}
            ctr={ctr.value}
            ctor={ctor.value}
          />
        </SectionCard>

        <SectionCard title="Audience demographics">
          <DemographicsChart rollup={demo} />
        </SectionCard>
      </div>

      {s.notes && (
        <SectionCard title="Notes" className="mt-6">
          <p className="text-sm text-ink">{s.notes}</p>
        </SectionCard>
      )}

      {/* Full editor */}
      <SectionCard title="Edit session" className="mt-6">
        <form action={updateSession} className="grid gap-3 sm:grid-cols-3">
          <input type="hidden" name="id" value={s.id} />
          <input name="title" defaultValue={s.title ?? ""} placeholder="Session title" className={`${inputCls} sm:col-span-3`} />
          <select name="brand_id" defaultValue={s.brand_id ?? ""} className={inputCls}>
            <option value="">Brand…</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select name="anchor_id" defaultValue={s.anchor_id ?? ""} className={inputCls}>
            <option value="">Anchor…</option>
            {anchors.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <select name="status" defaultValue={s.status} className={inputCls}>
            {SESSION_STATUSES.map((st) => (
              <option key={st} value={st}>{SESSION_STATUS_LABEL[st]}</option>
            ))}
          </select>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Started
            <input type="datetime-local" name="started_at" defaultValue={toManilaInput(s.started_at)} className={`${inputCls} mt-1 w-full`} />
          </label>
          <label className="text-[10px] uppercase tracking-wider text-ink-muted">
            Ended
            <input type="datetime-local" name="ended_at" defaultValue={toManilaInput(s.ended_at)} className={`${inputCls} mt-1 w-full`} />
          </label>
          <input name="duration_minutes" type="number" step="any" defaultValue={s.duration_minutes ?? ""} placeholder="Duration (min)" className={inputCls} />
          <input name="gmv" type="number" step="any" defaultValue={s.gmv ?? ""} placeholder="GMV" className={inputCls} />
          <input name="attributed_gmv" type="number" step="any" defaultValue={s.attributed_gmv ?? ""} placeholder="Attributed GMV" className={inputCls} />
          <input name="units_sold" type="number" defaultValue={s.units_sold ?? ""} placeholder="Units sold" className={inputCls} />
          <input name="products_sold" type="number" defaultValue={s.products_sold ?? ""} placeholder="Products sold" className={inputCls} />
          <input name="impressions" type="number" defaultValue={s.impressions ?? ""} placeholder="Impressions" className={inputCls} />
          <input name="clicks" type="number" defaultValue={s.clicks ?? ""} placeholder="Clicks" className={inputCls} />
          <input name="orders" type="number" defaultValue={s.orders ?? ""} placeholder="Orders" className={inputCls} />
          <input name="ctr" type="number" step="any" defaultValue={s.ctr ?? ""} placeholder="CTR (if no counts)" className={inputCls} />
          <input name="ctor" type="number" step="any" defaultValue={s.ctor ?? ""} placeholder="CTOR (if no counts)" className={inputCls} />
          <input name="peak_viewers" type="number" defaultValue={s.peak_viewers ?? ""} placeholder="Peak viewers" className={inputCls} />
          <input name="avg_viewers" type="number" defaultValue={s.avg_viewers ?? ""} placeholder="Avg viewers" className={inputCls} />
          <input name="demo_age" defaultValue={demoToText(demoAge)} placeholder="Age e.g. 18-24:30, 25-34:45" className={`${inputCls} sm:col-span-3`} />
          <input name="demo_gender" defaultValue={demoToText(demoGender)} placeholder="Gender e.g. female:70, male:30" className={`${inputCls} sm:col-span-3`} />
          <input name="demo_location" defaultValue={demoToText(demoLocation)} placeholder="Location e.g. Manila:40, Cebu:20" className={`${inputCls} sm:col-span-3`} />
          <input name="notes" defaultValue={s.notes ?? ""} placeholder="Notes (optional)" className={`${inputCls} sm:col-span-3`} />
          <button type="submit" className="rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-charcoal-950 hover:bg-teal-400 sm:col-span-3">
            Save changes
          </button>
        </form>
      </SectionCard>

      <div className="mt-6 flex justify-end">
        <form action={deleteSession}>
          <input type="hidden" name="id" value={s.id} />
          <input type="hidden" name="redirect_to" value="/live" />
          <button type="submit" className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300 hover:bg-red-500/20">
            Delete session
          </button>
        </form>
      </div>
    </AppShell>
  );
}
