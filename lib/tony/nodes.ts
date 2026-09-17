// lib/tony/nodes.ts — the ONE place that assembles the Tony Command View nodes.
//
// Every node's number is read live from the OS database through the caller's
// RLS-scoped server client (so leadership sees org-wide and a member sees only
// what policy permits). Nothing here fabricates a figure: an empty or missing
// source yields metric=null, which the UI renders as an honest "no data yet".
// Commerce GMV runs through the shared metrics layer (lib/metrics/gmv) so the
// Tony core agrees to the peso with the Command Center. Several domain tables
// (return_cases, content_items, creators, affiliate_deals, leads,
// tiktok_settlements, org/department briefings) aren't in the generated Database
// types yet — they're read through the same cast shim the rest of the app uses,
// each wrapped so a slow or unavailable source degrades to "no data yet" rather
// than crashing the hero screen. No schema or RLS changes are made here.

import type { createServerSupabaseClient } from "@/lib/supabase/server";
import type { SessionProfile } from "@/lib/auth/session";
import type { TonyNode, TonyView, NodeStatus } from "./types";
import { fetchCommerceRows, aggregate } from "@/lib/metrics/gmv";
import { getDataFreshness } from "@/lib/metrics/freshness";
import { monthToDate, todayManila, manilaStamp } from "@/lib/metrics/windows";
import { manilaDateOf } from "@/lib/metrics/live";
import { peso, pesoCompact, int } from "@/lib/metrics/format";

type Client = ReturnType<typeof createServerSupabaseClient>;
// Escape hatch for tables not in the generated types — the same pattern the
// Command Center and Accounts pages use. Reads only; never writes.
type UntypedClient = { from: (t: string) => any };

const STALE_HOURS = 48; // a commerce/report signal older than this reads "stale"
const RETURNS_ALERT = 5; // open return cases at/above this flip the node to red
const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

function ageMs(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}
function isStale(ageMillis: number | null): boolean {
  return ageMillis != null && ageMillis > STALE_HOURS * 3600 * 1000;
}
function maxIso(rows: Array<Record<string, unknown>>, col: string): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const v = r[col];
    if (typeof v === "string" && (best == null || v > best)) best = v;
  }
  return best;
}

// A latest grounded briefing (org-wide or department-scoped), read once and
// attached to the panels where it's the relevant read.
interface Brief {
  text: string | null;
  meta: string | null;
}
const NO_BRIEF: Brief = { text: null, meta: null };

function briefMeta(model: string | null, confidence: string | null, createdAt: string): string {
  const when = manilaStamp(createdAt);
  return [model ?? "AI", confidence ? `confidence ${confidence}` : null, when ? `${when} · Manila` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Assemble every Tony node for the given signed-in profile. All reads are
 * org-scoped by RLS on `supabase`; leadership-only domains (Finance) are
 * additionally gated by role so a member never sees a node they can't open.
 */
export async function getTonyView(supabase: Client, profile: SessionProfile): Promise<TonyView> {
  const u = supabase as unknown as UntypedClient;
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const mtd = monthToDate(nowMs);
  const today = todayManila(nowMs);
  const isLeadership = profile.role === "ceo" || profile.role === "coo";

  // Fire every read concurrently; each is defended so one empty/missing source
  // never sinks the page. Failed reads resolve to an empty/neutral shape.
  const safe = <T>(p: PromiseLike<T>, fallback: T): Promise<T> =>
    Promise.resolve(p).then((v) => v, () => fallback);

  const [
    bpmRows,
    freshness,
    brandsRes,
    returnsRes,
    contentRes,
    creatorsRes,
    dealsRes,
    leadsRes,
    tasksRes,
    reportRes,
    settleRes,
    liveRes,
    orgBriefRes,
    deptBriefRes,
    csiRes,
  ] = await Promise.all([
    safe(fetchCommerceRows(supabase), [] as Awaited<ReturnType<typeof fetchCommerceRows>>),
    safe(getDataFreshness(supabase), { asOf: null, source: null } as Awaited<ReturnType<typeof getDataFreshness>>),
    safe(u.from("brands").select("id, name, status, updated_at"), { data: [] as any[] }),
    safe(u.from("return_cases").select("status, updated_at"), { data: [] as any[] }),
    safe(u.from("content_items").select("status, updated_at"), { data: [] as any[] }),
    safe(u.from("creators").select("id, updated_at"), { data: [] as any[] }),
    safe(u.from("affiliate_deals").select("id, status, updated_at"), { data: [] as any[] }),
    safe(u.from("leads").select("stage, next_action_date, updated_at"), { data: [] as any[] }),
    safe(u.from("tasks").select("status, due_date, updated_at"), { data: [] as any[] }),
    safe(
      u.from("reports").select("title, type, created_at").order("created_at", { ascending: false }).limit(1),
      { data: [] as any[] }
    ),
    safe(u.from("tiktok_settlements").select("net_amount, synced_at"), { data: [] as any[] }),
    safe(
      u.from("live_sessions").select("status, anchor_id, gmv, started_at, created_at, updated_at"),
      { data: [] as any[] }
    ),
    safe(
      u
        .from("org_briefings")
        .select("summary, model, data_confidence, created_at")
        .order("created_at", { ascending: false })
        .limit(1),
      { data: [] as any[] }
    ),
    safe(
      u
        .from("department_briefings")
        .select("action_plan, challenges_summary, model, data_confidence, created_at")
        .order("created_at", { ascending: false })
        .limit(1),
      { data: [] as any[] }
    ),
    // Agent CSI findings — the ONE live number is how many are still unreviewed.
    safe(
      u.from("csi_findings").select("status, job_type, discovered_at"),
      { data: [] as any[] }
    ),
  ]);

  // ── Latest briefings ──
  const ob = (orgBriefRes.data ?? [])[0] as
    | { summary: string | null; model: string | null; data_confidence: string | null; created_at: string }
    | undefined;
  const orgBrief: Brief = ob?.summary
    ? { text: ob.summary, meta: `Org briefing · ${briefMeta(ob.model, ob.data_confidence, ob.created_at)}` }
    : NO_BRIEF;
  const db = (deptBriefRes.data ?? [])[0] as
    | {
        action_plan: string | null;
        challenges_summary: string | null;
        model: string | null;
        data_confidence: string | null;
        created_at: string;
      }
    | undefined;
  const deptBrief: Brief = db && (db.action_plan || db.challenges_summary)
    ? {
        text: db.action_plan || db.challenges_summary,
        meta: `Department briefing · ${briefMeta(db.model, db.data_confidence, db.created_at)}`,
      }
    : NO_BRIEF;

  const nodes: TonyNode[] = [];

  // ── 1. Commerce / EcomSmart — MTD GMV ──
  {
    const agg = aggregate(bpmRows, mtd);
    const recency = ageMs(freshness.asOf, nowMs);
    const status: NodeStatus = !agg.hasData ? "muted" : isStale(recency) ? "amber" : "green";
    nodes.push({
      id: "commerce",
      label: "Commerce",
      domain: "EcomSmart",
      metric: agg.hasData ? peso(agg.gmv, agg.currency) : null,
      metricNote: "MTD GMV",
      status,
      href: "/",
      actionLabel: "Open Command Center",
      stats: [
        { label: "MTD GMV", value: agg.hasData ? peso(agg.gmv, agg.currency) : "—" },
        { label: "Orders", value: agg.hasData ? int(agg.orders) : "—" },
        { label: "AOV", value: agg.aov != null ? peso(agg.aov, agg.currency) : "—" },
        { label: "Ad spend", value: agg.adSpend > 0 ? peso(agg.adSpend, agg.currency) : "—" },
      ],
      brief: orgBrief.text,
      briefMeta: orgBrief.meta,
      hint: agg.hasData
        ? isStale(recency)
          ? "Data may be stale — no fresh sync in 48h+"
          : null
        : "No platform metrics imported or synced yet",
      recencyMs: recency,
    });
  }

  // ── 2. Brands — active count + top brand by GMV ──
  {
    const brands = (brandsRes.data ?? []) as { id: string; name: string; status: string; updated_at: string }[];
    const active = brands.filter((b) => (b.status ?? "").toLowerCase() === "active").length;
    let top: { name: string; gmv: number; currency: string } | null = null;
    for (const b of brands) {
      const bAgg = aggregate(bpmRows, mtd, { brandId: b.id });
      if (bAgg.hasData && (top == null || bAgg.gmv > top.gmv)) {
        top = { name: b.name, gmv: bAgg.gmv, currency: bAgg.currency };
      }
    }
    const status: NodeStatus = brands.length === 0 ? "muted" : active > 0 ? "green" : "amber";
    nodes.push({
      id: "brands",
      label: "Brands",
      domain: "Portfolio",
      metric: brands.length > 0 ? `${active} active` : null,
      metricNote: brands.length > 0 ? `of ${brands.length} brands` : null,
      status,
      href: "/brands",
      actionLabel: "View brand portfolio",
      stats: [
        { label: "Active brands", value: brands.length > 0 ? String(active) : "—" },
        { label: "Total brands", value: brands.length > 0 ? String(brands.length) : "—" },
        { label: "Top brand (MTD)", value: top ? top.name : "—" },
        { label: "Top brand GMV", value: top ? peso(top.gmv, top.currency) : "—" },
      ],
      brief: orgBrief.text,
      briefMeta: orgBrief.meta,
      hint: brands.length === 0 ? "No brands on file yet" : top ? null : "No brand GMV for MTD yet",
      recencyMs: ageMs(maxIso(brands, "updated_at"), nowMs),
    });
  }

  // ── 3. Warehouse / RTS — open return cases ──
  {
    const SETTLED = new Set(["refunded", "restocked", "closed"]);
    const cases = (returnsRes.data ?? []) as { status: string | null; updated_at: string }[];
    const open = cases.filter((c) => !SETTLED.has((c.status ?? "").toLowerCase())).length;
    const status: NodeStatus =
      cases.length === 0 ? "muted" : open >= RETURNS_ALERT ? "red" : open > 0 ? "amber" : "green";
    nodes.push({
      id: "warehouse",
      label: "Warehouse",
      domain: "Returns / RTS",
      metric: cases.length > 0 ? `${open} open` : null,
      metricNote: cases.length > 0 ? "return cases" : null,
      status,
      href: "/warehouse",
      actionLabel: "Open returns tracker",
      stats: [
        { label: "Open cases", value: cases.length > 0 ? String(open) : "—" },
        { label: "Total logged", value: cases.length > 0 ? String(cases.length) : "—" },
        { label: "Settled", value: cases.length > 0 ? String(cases.length - open) : "—" },
      ],
      brief: deptBrief.text,
      briefMeta: deptBrief.meta,
      hint:
        cases.length === 0
          ? "No return cases logged yet"
          : open >= RETURNS_ALERT
          ? "Returns spike — needs attention"
          : null,
      recencyMs: ageMs(maxIso(cases, "updated_at"), nowMs),
    });
  }

  // ── 4. Creative / Opera — content in production + scheduled ──
  {
    const items = (contentRes.data ?? []) as { status: string | null; updated_at: string }[];
    const prod = items.filter((i) => (i.status ?? "").toLowerCase() === "production").length;
    const sched = items.filter((i) => (i.status ?? "").toLowerCase() === "scheduled").length;
    const activeCount = prod + sched;
    const status: NodeStatus = items.length === 0 ? "muted" : activeCount > 0 ? "green" : "amber";
    nodes.push({
      id: "creative",
      label: "Creative",
      domain: "Opera Studio",
      metric: items.length > 0 ? String(activeCount) : null,
      metricNote: items.length > 0 ? "in production + scheduled" : null,
      status,
      href: "/creative-studio",
      actionLabel: "Open Creative Studio",
      stats: [
        { label: "In production", value: items.length > 0 ? String(prod) : "—" },
        { label: "Scheduled", value: items.length > 0 ? String(sched) : "—" },
        { label: "Total items", value: items.length > 0 ? String(items.length) : "—" },
      ],
      brief: deptBrief.text,
      briefMeta: deptBrief.meta,
      hint:
        items.length === 0
          ? "No content items yet"
          : activeCount === 0
          ? "Nothing in production or scheduled"
          : null,
      recencyMs: ageMs(maxIso(items, "updated_at"), nowMs),
    });
  }

  // ── 5. Affiliate — creators + affiliate deals ──
  {
    const creators = (creatorsRes.data ?? []) as { id: string; updated_at: string }[];
    const deals = (dealsRes.data ?? []) as { id: string; status: string | null; updated_at: string }[];
    const activeDeals = deals.filter((d) => (d.status ?? "").toLowerCase() === "active").length;
    const status: NodeStatus = creators.length === 0 && deals.length === 0 ? "muted" : creators.length > 0 ? "green" : "amber";
    nodes.push({
      id: "affiliate",
      label: "Affiliate",
      domain: "Creator Network",
      metric: creators.length > 0 || deals.length > 0 ? `${creators.length} creators` : null,
      metricNote: creators.length > 0 || deals.length > 0 ? `${deals.length} deals` : null,
      status,
      href: "/creators",
      actionLabel: "View creators",
      stats: [
        { label: "Creators", value: creators.length > 0 ? String(creators.length) : "—" },
        { label: "Affiliate deals", value: deals.length > 0 ? String(deals.length) : "—" },
        { label: "Active deals", value: deals.length > 0 ? String(activeDeals) : "—" },
      ],
      brief: deptBrief.text,
      briefMeta: deptBrief.meta,
      hint: creators.length === 0 && deals.length === 0 ? "No creators or deals yet" : null,
      recencyMs: ageMs(maxIso([...creators, ...deals], "updated_at"), nowMs),
    });
  }

  // ── 5b. Live Selling — anchors live now + today's live GMV ──
  {
    const rows = (liveRes.data ?? []) as {
      status: string | null;
      anchor_id: string | null;
      gmv: number | null;
      started_at: string | null;
      created_at: string;
      updated_at: string;
    }[];
    const liveRows = rows.filter((r) => (r.status ?? "").toLowerCase() === "live");
    // "Anchors live now" counts distinct anchors on air, falling back to the raw
    // live-session count when sessions have no anchor linked.
    const distinctLiveAnchors = new Set(liveRows.map((r) => r.anchor_id).filter(Boolean)).size;
    const anchorsLiveNow = distinctLiveAnchors > 0 ? distinctLiveAnchors : liveRows.length;
    const onToday = (r: { started_at: string | null; created_at: string }) =>
      (manilaDateOf(r.started_at) ?? manilaDateOf(r.created_at)) === today;
    const hasToday = rows.some(onToday);
    const todaysGmv = rows.reduce((a, r) => (onToday(r) ? a + num(r.gmv) : a), 0);
    const status: NodeStatus = rows.length === 0 ? "muted" : liveRows.length > 0 ? "green" : "amber";
    nodes.push({
      id: "live",
      label: "Live",
      domain: "Live Selling",
      // The ONE live number: anchors on air when someone's live, else today's
      // live GMV, else an honest "no data yet".
      metric:
        liveRows.length > 0
          ? `${anchorsLiveNow} live now`
          : hasToday
          ? peso(todaysGmv)
          : null,
      metricNote: liveRows.length > 0 ? "anchors on air" : hasToday ? "today's live GMV" : null,
      status,
      href: "/live",
      actionLabel: "Open Live Selling",
      stats: [
        { label: "Anchors live now", value: rows.length ? String(anchorsLiveNow) : "—" },
        { label: "Live sessions now", value: rows.length ? String(liveRows.length) : "—" },
        { label: "Today's live GMV", value: hasToday ? peso(todaysGmv) : "—" },
        { label: "Sessions logged", value: rows.length ? String(rows.length) : "—" },
      ],
      brief: deptBrief.text,
      briefMeta: deptBrief.meta,
      hint:
        rows.length === 0
          ? "No live sessions logged yet"
          : liveRows.length > 0
          ? `${liveRows.length} session${liveRows.length === 1 ? "" : "s"} live right now`
          : "No anchors live right now",
      recencyMs: ageMs(maxIso(rows, "updated_at"), nowMs),
    });
  }

  // ── 6. BizDev — open leads + follow-ups due today ──
  {
    const CLOSED = new Set(["won", "lost"]);
    const leads = (leadsRes.data ?? []) as {
      stage: string | null;
      next_action_date: string | null;
      updated_at: string;
    }[];
    const openLeads = leads.filter((l) => !CLOSED.has((l.stage ?? "").toLowerCase())).length;
    const dueToday = leads.filter(
      (l) => !CLOSED.has((l.stage ?? "").toLowerCase()) && l.next_action_date != null && l.next_action_date <= today
    ).length;
    const status: NodeStatus = leads.length === 0 ? "muted" : dueToday > 0 ? "amber" : "green";
    nodes.push({
      id: "bizdev",
      label: "BizDev",
      domain: "Outreach",
      metric: leads.length > 0 ? `${openLeads} open` : null,
      metricNote: leads.length > 0 ? "leads" : null,
      status,
      href: "/leads",
      actionLabel: "Open lead pipeline",
      stats: [
        { label: "Open leads", value: leads.length > 0 ? String(openLeads) : "—" },
        { label: "Follow-ups due", value: leads.length > 0 ? String(dueToday) : "—" },
        { label: "Total leads", value: leads.length > 0 ? String(leads.length) : "—" },
      ],
      brief: deptBrief.text,
      briefMeta: deptBrief.meta,
      hint:
        leads.length === 0
          ? "No leads in the pipeline yet"
          : dueToday > 0
          ? `${dueToday} follow-up${dueToday === 1 ? "" : "s"} due today`
          : null,
      recencyMs: ageMs(maxIso(leads, "updated_at"), nowMs),
    });
  }

  // ── 7. Trend / CSI — Agent CSI deep-research findings ──
  {
    const findings = (csiRes.data ?? []) as {
      status: string | null;
      job_type: string | null;
      discovered_at: string | null;
    }[];
    const newCount = findings.filter((f) => (f.status ?? "").toLowerCase() === "new").length;
    const trends = findings.filter((f) => (f.job_type ?? "") === "trend").length;
    const opps = findings.filter((f) => (f.job_type ?? "") === "business_opportunity").length;
    const status: NodeStatus =
      findings.length === 0 ? "muted" : newCount > 0 ? "green" : "amber";
    nodes.push({
      id: "trend",
      label: "Trend",
      domain: "CSI",
      // The ONE live number: how many findings are still unreviewed, else the
      // total on file, else an honest "no data yet".
      metric:
        findings.length > 0
          ? newCount > 0
            ? `${newCount} new`
            : `${findings.length} findings`
          : null,
      metricNote: findings.length > 0 ? (newCount > 0 ? "unreviewed findings" : "all reviewed") : null,
      status,
      href: "/csi",
      actionLabel: "Open Agent CSI",
      stats: [
        { label: "New findings", value: findings.length > 0 ? String(newCount) : "—" },
        { label: "Trends", value: findings.length > 0 ? String(trends) : "—" },
        { label: "Opportunities", value: findings.length > 0 ? String(opps) : "—" },
        { label: "Total on file", value: findings.length > 0 ? String(findings.length) : "—" },
      ],
      brief: null,
      briefMeta: null,
      hint:
        findings.length === 0
          ? "No research findings yet — run Agent CSI to gather sourced intel"
          : newCount > 0
          ? `${newCount} finding${newCount === 1 ? "" : "s"} awaiting review`
          : null,
      recencyMs: ageMs(maxIso(findings, "discovered_at"), nowMs),
    });
  }

  // ── 8. Finance — net settlements (leadership only) ──
  if (isLeadership) {
    const settle = (settleRes.data ?? []) as { net_amount: number | null; synced_at: string | null }[];
    const net = settle.reduce((a, r) => a + num(r.net_amount), 0);
    const recency = ageMs(maxIso(settle as any, "synced_at"), nowMs);
    const status: NodeStatus = settle.length === 0 ? "muted" : isStale(recency) ? "amber" : "green";
    nodes.push({
      id: "finance",
      label: "Finance",
      domain: "Settlements",
      metric: settle.length > 0 ? peso(net) : null,
      metricNote: settle.length > 0 ? "net settlements" : null,
      status,
      href: "/finance",
      actionLabel: "Open Finance",
      stats: [
        { label: "Net settlements", value: settle.length > 0 ? peso(net) : "—" },
        { label: "Statements", value: settle.length > 0 ? String(settle.length) : "—" },
        { label: "Net (compact)", value: settle.length > 0 ? pesoCompact(net) : "—" },
      ],
      brief: orgBrief.text,
      briefMeta: orgBrief.meta,
      hint: settle.length === 0 ? "No settlements synced yet" : isStale(recency) ? "Settlement data may be stale" : null,
      recencyMs: recency,
    });
  }

  // ── 9. Tasks / Ops — open + overdue ──
  {
    const DONE = new Set(["done", "cancelled"]);
    const tasks = (tasksRes.data ?? []) as { status: string; due_date: string | null; updated_at: string }[];
    const open = tasks.filter((t) => !DONE.has(t.status)).length;
    const overdue = tasks.filter((t) => !DONE.has(t.status) && t.due_date != null && t.due_date < today).length;
    const status: NodeStatus = tasks.length === 0 ? "muted" : overdue > 0 ? "red" : open > 0 ? "amber" : "green";
    nodes.push({
      id: "tasks",
      label: "Tasks",
      domain: "Operations",
      metric: tasks.length > 0 ? `${open} open` : null,
      metricNote: tasks.length > 0 ? (overdue > 0 ? `${overdue} overdue` : "on track") : null,
      status,
      href: "/tasks",
      actionLabel: "Open task board",
      stats: [
        { label: "Open tasks", value: tasks.length > 0 ? String(open) : "—" },
        { label: "Overdue", value: tasks.length > 0 ? String(overdue) : "—" },
        { label: "Total tasks", value: tasks.length > 0 ? String(tasks.length) : "—" },
      ],
      brief: deptBrief.text,
      briefMeta: deptBrief.meta,
      hint:
        tasks.length === 0
          ? "No tasks yet"
          : overdue > 0
          ? `${overdue} task${overdue === 1 ? "" : "s"} overdue`
          : null,
      recencyMs: ageMs(maxIso(tasks, "updated_at"), nowMs),
    });
  }

  // ── 10. Reports — last report generated ──
  {
    const rep = (reportRes.data ?? [])[0] as
      | { title: string; type: string; created_at: string }
      | undefined;
    const recency = ageMs(rep?.created_at ?? null, nowMs);
    const status: NodeStatus = !rep ? "muted" : isStale(recency) ? "amber" : "green";
    const when = rep ? manilaStamp(rep.created_at) : null;
    nodes.push({
      id: "reports",
      label: "Reports",
      domain: "Briefings",
      metric: rep ? (when ?? "Generated") : null,
      metricNote: rep ? "last report" : null,
      status,
      href: "/reports",
      actionLabel: "Open reports",
      stats: [
        { label: "Latest report", value: rep ? rep.title : "—" },
        { label: "Type", value: rep ? rep.type : "—" },
        { label: "Generated", value: when ?? "—" },
      ],
      brief: orgBrief.text,
      briefMeta: orgBrief.meta,
      hint: !rep ? "No reports generated yet" : isStale(recency) ? "Latest report is 48h+ old" : null,
      recencyMs: recency,
    });
  }

  return {
    nodes,
    asOf: freshness.asOf,
    freshnessSource: freshness.source,
    nowIso,
    windowLabel: mtd.label,
  };
}
