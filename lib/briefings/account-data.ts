// lib/briefings/account-data.ts
// Account-intelligence data gathering + truthfulness/red-flag computation,
// lifted verbatim from the Accounts page so the SAME logic feeds both the
// Account Intelligence drill-down and the shared account-briefing generator.
// Pure, code-truthful helpers — no AI, no invented numbers. RLS org-scopes the
// passed client.
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { fetchCommerceRows } from "@/lib/metrics/gmv";

type Supabase = ReturnType<typeof createServerSupabaseClient>;

export type Bpm = {
  brand_id: string;
  platform: string;
  period_start: string | null;
  period_end: string | null;
  gmv: number | null;
  orders: number | null;
  units: number | null;
  returns: number | null;
  return_rate: number | null;
  roas: number | null;
  ad_spend: number | null;
  fulfillment_errors: number | null;
  source: string;
  updated_at: string;
};
export type SnapLite = { id: string; period_end: string | null; created_at: string };
export type TaskLite = { id: string; title: string; status: string; due_date: string | null; priority: string };
export type CampaignLite = { id: string; name: string; status: string };

export type BrandData = { bpm: Bpm[]; snaps: SnapLite[]; tasks: TaskLite[]; campaigns: CampaignLite[] };
export type Badge = { confidence: string; sourceLabel: string; ageText: string; tone: "teal" | "amber" | "muted" };

export function peso(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "PHP", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `PHP ${Math.round(n)}`;
  }
}

export const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));

const TODAY = () => new Date().toISOString().slice(0, 10);

function daysSince(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

// A return_rate stored as a fraction (0.12) or a percent (12) — normalise to %.
export function returnPct(rr: number | null | undefined): number | null {
  if (rr == null) return null;
  const n = Number(rr);
  if (Number.isNaN(n)) return null;
  return n <= 1 ? n * 100 : n;
}

// `orgId` is optional: under the request-scoped RLS client it is redundant (RLS
// scopes every read to current_org_id()), but a SERVICE-ROLE caller — the GitHub Actions
// machine refresh — bypasses RLS, so it must scope the org-wide snapshot read
// itself. brandId already isolates the commerce/task/campaign reads (brand_id is
// globally unique), so only the metrics_snapshots read needs the explicit filter.
export async function gatherBrandData(
  supabase: Supabase,
  brandId: string,
  orgId?: string
): Promise<BrandData> {
  const u = supabase as unknown as { from: (t: string) => any };
  let snapQuery = u
    .from("metrics_snapshots")
    .select("id, period_end, created_at")
    .order("period_end", { ascending: false })
    .limit(20);
  if (orgId) snapQuery = snapQuery.eq("org_id", orgId);

  const [commerceRows, snapRes, taskRes, campRes] = await Promise.all([
    // Live per-brand commerce from tiktok_shop_performance (one row per day), never
    // the retired brand_platform_metrics. The columns the live source doesn't carry
    // (returns / return_rate / roas / ad_spend / fulfillment_errors) arrive null, so
    // the briefing renders them "n/a" — never a stale bpm figure or a fabricated 0.
    fetchCommerceRows(supabase, { brandId, orgId }),
    snapQuery,
    supabase
      .from("tasks")
      .select("id, title, status, due_date, priority")
      .eq("brand_id", brandId)
      .order("due_date", { ascending: true }),
    supabase.from("campaigns").select("id, name, status").eq("brand_id", brandId),
  ]);

  return {
    // Latest day first (the live reader returns ascending) so bpm[0] stays "latest".
    bpm: [...(commerceRows as unknown as Bpm[])].reverse(),
    snaps: (snapRes.data ?? []) as unknown as SnapLite[],
    tasks: (taskRes.data ?? []) as unknown as TaskLite[],
    campaigns: (campRes.data ?? []) as unknown as CampaignLite[],
  };
}

// ── Truthfulness badge (computed in code, no AI) ─────────────────────────────
export function computeBadge(data: BrandData): Badge {
  const latest = data.bpm[0];
  if (!latest && data.snaps.length === 0) {
    return { confidence: "insufficient", sourceLabel: "No data", ageText: "no metrics on file", tone: "muted" };
  }
  if (!latest) {
    // Only hand-entered department snapshots exist for the org.
    const age = daysSince(data.snaps[0]?.period_end ?? data.snaps[0]?.created_at);
    return {
      confidence: "low",
      sourceLabel: "Stale / hand-entered",
      ageText: age == null ? "hand-entered" : `updated ${age} day${age === 1 ? "" : "s"} ago`,
      tone: "amber",
    };
  }

  const freshDate =
    daysSince(latest.period_end) != null && daysSince(latest.updated_at) != null
      ? Math.min(daysSince(latest.period_end)!, daysSince(latest.updated_at)!)
      : daysSince(latest.period_end) ?? daysSince(latest.updated_at);
  const age = freshDate ?? 0;
  const ageText = `updated ${age} day${age === 1 ? "" : "s"} ago`;
  const src = (latest.source ?? "").toLowerCase();
  const isSync = /api|sync|windsor/.test(src);
  const isImport = /import|xlsx|manual|sheet|csv/.test(src);

  if (isSync && age < 3) return { confidence: "high", sourceLabel: "Live-synced", ageText, tone: "teal" };
  if (isImport && age < 21) return { confidence: "medium", sourceLabel: "Manual import", ageText, tone: "amber" };
  return { confidence: "low", sourceLabel: "Stale / hand-entered", ageText, tone: "amber" };
}

// ── Challenges + bottlenecks (rule-based, real numbers) ──────────────────────
export function computeFlags(data: BrandData): string[] {
  const today = TODAY();
  const flags: string[] = [];
  const latest = data.bpm[0];

  const overdue = data.tasks.filter(
    (t) => t.due_date && t.due_date < today && t.status !== "done" && t.status !== "cancelled"
  );
  if (overdue.length > 0) {
    flags.push(`${overdue.length} overdue task${overdue.length === 1 ? "" : "s"} (e.g. "${overdue[0].title}").`);
  }

  if (latest) {
    const rp = returnPct(latest.return_rate);
    if (rp != null && rp > 10) flags.push(`High return rate: ${rp.toFixed(1)}% (latest period).`);

    if (latest.roas != null && Number(latest.roas) < 2) {
      flags.push(`Low ROAS: ${(Math.round(Number(latest.roas) * 100) / 100).toFixed(2)}× (latest period).`);
    }

    if (latest.fulfillment_errors != null && Number(latest.fulfillment_errors) > 0) {
      flags.push(`${num(latest.fulfillment_errors)} fulfillment error${num(latest.fulfillment_errors) === 1 ? "" : "s"} (latest period).`);
    }
  }

  // GMV trend: newest period vs the prior distinct period (summed across channels).
  const byPeriod = new Map<string, number>();
  for (const r of data.bpm) {
    if (!r.period_end) continue;
    byPeriod.set(r.period_end, (byPeriod.get(r.period_end) ?? 0) + num(r.gmv));
  }
  const periods = Array.from(byPeriod.keys()).sort().reverse();
  if (periods.length >= 2) {
    const cur = byPeriod.get(periods[0]) ?? 0;
    const prev = byPeriod.get(periods[1]) ?? 0;
    if (cur < prev) flags.push(`GMV down vs prior period: ${peso(cur)} from ${peso(prev)}.`);
  }

  // No metrics in the last 21 days.
  const latestAge = latest ? daysSince(latest.period_end) ?? daysSince(latest.updated_at) : null;
  if (!latest) {
    flags.push("No platform metrics recorded for this client.");
  } else if (latestAge != null && latestAge > 21) {
    flags.push(`No fresh metrics in ${latestAge} days — latest data may be stale.`);
  }

  if (!data.campaigns.some((c) => c.status === "active")) {
    flags.push("No active campaign running for this client.");
  }

  return flags;
}

// Extract a JSON object from a model's text (tolerates code fences / prose).
export function parseBriefingJson<T = Record<string, unknown>>(text: string): T | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export const ACCOUNT_SYSTEM_PROMPT =
  "You are a senior marketing-operations strategist for a Philippine TikTok Shop & Shopee agency. Using ONLY the data provided, do not invent any numbers. Assess the account, then give EXACTLY 3 forward-looking solutions that get ahead of the problems, each with a one-line 'why' and exactly 3 concrete next steps. If the data is too thin to be confident, say so in the summary and lower your confidence. Respond ONLY as strict JSON: {\"data_confidence\":\"high|medium|low|insufficient\",\"summary\":\"...\",\"challenges\":[\"...\"],\"bottlenecks\":[\"...\"],\"solutions\":[{\"solution\":\"...\",\"why\":\"...\",\"steps\":[\"...\",\"...\",\"...\"]}]}";

// Build the compact, factual account context the model may reason over.
export function buildAccountPrompt(data: BrandData, badge: Badge, flags: string[]): string {
  const latest = data.bpm[0];
  const lines: string[] = [];
  lines.push(`Truthfulness: ${badge.confidence} (${badge.sourceLabel}, ${badge.ageText}).`);
  if (latest) {
    lines.push(
      `Latest platform metrics (${latest.period_start ?? "?"} → ${latest.period_end ?? "?"}, source ${latest.source}): ` +
        `GMV ${latest.gmv != null ? peso(num(latest.gmv)) : "n/a"}, orders ${latest.orders ?? "n/a"}, units ${latest.units ?? "n/a"}, ` +
        `returns ${latest.returns ?? "n/a"}, return_rate ${returnPct(latest.return_rate) != null ? returnPct(latest.return_rate)!.toFixed(1) + "%" : "n/a"}, ` +
        `ROAS ${latest.roas != null ? Number(latest.roas) + "x" : "n/a"}, ad_spend ${latest.ad_spend != null ? peso(num(latest.ad_spend)) : "n/a"}, ` +
        `fulfillment_errors ${latest.fulfillment_errors ?? "n/a"}.`
    );
    lines.push(`Live TikTok Shop daily rows on file: ${data.bpm.length}.`);
  } else {
    lines.push("No live TikTok Shop commerce rows on file.");
  }
  lines.push(`Tasks: ${data.tasks.length} total, ${data.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length} open.`);
  lines.push(`Campaigns: ${data.campaigns.length} total, ${data.campaigns.filter((c) => c.status === "active").length} active.`);
  lines.push(`Computed red flags: ${flags.length ? flags.join(" ") : "none on the available data."}`);
  return lines.join("\n");
}
