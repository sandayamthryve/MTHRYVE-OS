// lib/briefings/org-briefing-core.ts
// PR 7 — the ONE org-briefing generation core, shared by the interactive
// "Refresh briefing" server action (lib/briefings/generate.ts) and the GitHub Actions daily
// regeneration route (app/api/automation/exec-briefing). Extracting it here means
// a human refresh and the scheduled machine run build the SAME grounded prompt
// against the SAME canonical sources and write the SAME org_briefings shape — the
// narrative can never diverge by path.
//
// Every input is gathered with an EXPLICIT org_id filter, so this works unchanged
// under the request-scoped RLS client (where the filter is redundant) AND under
// the service-role client (where it is required — RLS is bypassed, so the machine
// run must scope each org itself, exactly like lib/metrics/rollup.ts).
//
// Grounds ONLY in real rows; refuses to invent when data is too thin (records an
// honest "insufficient" note, no AI call). Never throws for the caller — it
// returns a small status object so the route can fold many orgs and the action
// can revalidate.
import { peso as fmtPeso } from "@/lib/metrics/format";
import { todayManila } from "@/lib/metrics/windows";
import { fetchCommerceRows } from "@/lib/metrics/gmv";
import { efficiencyFrom, type SignalValue, type TaskLite } from "@/lib/metrics/signals";
import { fetchConfirmedCompletions } from "@/lib/daily-reports/confirmations";
import { anthropicMessages } from "@/lib/briefings/anthropic";
import { parseBriefingJson } from "@/lib/briefings/account-data";
import type { Chip, Highlight } from "@/lib/briefings/read";

// A minimal structural client — satisfied by both the RLS server client and the
// service-role client. Reads use the same PostgREST chain shape the rest of the
// briefing layer casts to.
type AnyClient = { from: (t: string) => any };

const num = (v: number | null | undefined) => (v == null ? 0 : Number(v));

export const ORG_SYSTEM_PROMPT =
  "You are the executive strategist for a Philippine TikTok Shop & Shopee agency. " +
  "Using ONLY the data provided, never invent numbers. Write a 3-4 sentence executive briefing, " +
  "then up to 5 chips and up to 3 forward insights. Respond ONLY as JSON: " +
  '{"data_confidence":"...","summary":"...","chips":[{"label":"...","tone":"up|down|warn|flag"}],' +
  '"highlights":[{"kind":"opportunity|risk|ops","text":"..."}]}';

export const ORG_INSUFFICIENT_SUMMARY =
  "Not enough data to brief on yet. Feed the OS to unlock an executive briefing: import a platform metrics row (TikTok Shop / Shopee) for at least one brand, and record a couple of weekly department snapshots. Once real figures exist, refresh this briefing.";

// YYYY-MM bucket of a date string.
function monthKey(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const s = String(dateStr);
  return s.length >= 7 ? s.slice(0, 7) : null;
}

type OrgMetricLite = {
  department_id: string | null;
  efficiency: number;
  quality_score: number;
  capacity_utilization: number;
  period_end: string;
};

// The gathered, real numbers a briefing reasons over — nothing derived by AI.
export interface OrgBriefingNumbers {
  curMonth: string;
  priorMonth: string;
  gmvCur: number;
  gmvPrior: number;
  platformRows: number; // commerce rows on file
  snapCount: number; // department snapshots on file
  effAvg: number | null; // avg confirmed efficiency across departments
  effDeptCount: number; // departments contributing a confirmed efficiency
  latestPeriod: string | null;
  latestDeptCount: number; // departments in the latest snapshot period
  qualAvg: number;
  capAvg: number;
  pendingApprovals: number;
  statusLine: string;
  period_start: string;
  period_end: string;
}

// Gather the real figures for one org. Explicit org_id everywhere → correct under
// both clients.
export async function gatherOrgBriefingNumbers(
  client: AnyClient,
  orgId: string,
  nowMs: number = Date.now()
): Promise<OrgBriefingNumbers> {
  const today = todayManila(nowMs);
  const period_start = `${today.slice(0, 7)}-01`;

  const [bpm, snapRes, apprRes, brandRes, taskRes, userRes, confirmed] = await Promise.all([
    fetchCommerceRows(client as any, { orgId }),
    client
      .from("metrics_snapshots")
      .select("department_id, efficiency, quality_score, capacity_utilization, period_end")
      .eq("org_id", orgId)
      .not("department_id", "is", null)
      .order("period_end", { ascending: false }),
    client.from("approval_requests").select("id").eq("org_id", orgId).eq("status", "pending"),
    client.from("brands").select("status").eq("org_id", orgId),
    client.from("tasks").select("id, status, due_date, assignee_id").eq("org_id", orgId),
    client.from("users").select("id, department_id").eq("org_id", orgId),
    fetchConfirmedCompletions(client),
  ]);

  const snaps = (snapRes.data ?? []) as unknown as OrgMetricLite[];
  const pendingApprovals = (apprRes.data ?? []).length;
  const brandRows = (brandRes.data ?? []) as unknown as { status: string }[];

  const curMonth = today.slice(0, 7);
  const d = new Date(`${period_start}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const priorMonth = d.toISOString().slice(0, 10).slice(0, 7);

  const gmvCur = bpm
    .filter((r) => monthKey(r.period_end) === curMonth)
    .reduce((a, r) => a + num(r.gmv), 0);
  const gmvPrior = bpm
    .filter((r) => monthKey(r.period_end) === priorMonth)
    .reduce((a, r) => a + num(r.gmv), 0);

  const periods = Array.from(new Set(snaps.map((s) => s.period_end))).sort().reverse();
  const latestRows = snaps.filter((s) => s.period_end === periods[0]);
  const avg = (rows: OrgMetricLite[], pick: (m: OrgMetricLite) => number) =>
    rows.length ? rows.reduce((a, m) => a + num(pick(m)), 0) / rows.length : 0;
  const qualAvg = Math.round(avg(latestRows, (m) => m.quality_score));
  const capAvg = Math.round(avg(latestRows, (m) => m.capacity_utilization));

  // Per-department confirmed efficiency (the SAME derivation
  // computeDepartmentEfficiency uses, org-scoped explicitly), then averaged — the
  // one confirmed-daily-report signal, honest null when nothing is confirmed.
  const deptByUser = new Map<string, string | null>();
  for (const u of (userRes.data ?? []) as { id: string; department_id: string | null }[]) {
    deptByUser.set(u.id, u.department_id);
  }
  type TaskWithAssignee = TaskLite & { assignee_id: string | null };
  const tasksByDept = new Map<string, TaskLite[]>();
  for (const t of (taskRes.data ?? []) as unknown as TaskWithAssignee[]) {
    const deptId = t.assignee_id ? deptByUser.get(t.assignee_id) ?? null : null;
    if (!deptId) continue;
    const list = tasksByDept.get(deptId) ?? [];
    list.push({ id: t.id, status: t.status, due_date: t.due_date });
    tasksByDept.set(deptId, list);
  }
  const effValues: number[] = [];
  for (const [, deptTasks] of tasksByDept) {
    const s: SignalValue = efficiencyFrom(deptTasks, confirmed, today);
    if (s.value != null) effValues.push(s.value);
  }
  const effAvg = effValues.length
    ? Math.round(effValues.reduce((a, b) => a + b, 0) / effValues.length)
    : null;

  const byStatus = new Map<string, number>();
  for (const b of brandRows) byStatus.set(b.status, (byStatus.get(b.status) ?? 0) + 1);
  const statusLine = Array.from(byStatus.entries())
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");

  return {
    curMonth,
    priorMonth,
    gmvCur,
    gmvPrior,
    platformRows: bpm.length,
    snapCount: snaps.length,
    effAvg,
    effDeptCount: effValues.length,
    latestPeriod: periods[0] ?? null,
    latestDeptCount: latestRows.length,
    qualAvg,
    capAvg,
    pendingApprovals,
    statusLine,
    period_start,
    period_end: today,
  };
}

// Is there enough real data to justify an AI briefing at all? (No commerce rows
// AND fewer than two department snapshots → no.)
export function orgDataSufficient(n: OrgBriefingNumbers): boolean {
  return !(n.platformRows === 0 && n.snapCount < 2);
}

// Baseline confidence before the model may override it.
export function orgBaseConfidence(n: OrgBriefingNumbers): string {
  return n.platformRows && n.snapCount >= 2 ? "medium" : "low";
}

// The grounded user prompt — the exact factual lines the model sees.
export function buildOrgUserPrompt(n: OrgBriefingNumbers): string {
  const lines: string[] = [];
  lines.push(
    `GMV month-to-date (${n.curMonth}): ${n.platformRows ? fmtPeso(n.gmvCur) : "no platform rows"}` +
      (n.gmvPrior > 0 ? `; prior month (${n.priorMonth}): ${fmtPeso(n.gmvPrior)}.` : ".")
  );
  const effText =
    n.effAvg != null
      ? `${n.effAvg}% (confirmed via daily reports across ${n.effDeptCount} department${n.effDeptCount === 1 ? "" : "s"})`
      : "no confirmed daily-report completions yet";
  lines.push(
    n.latestDeptCount
      ? `Confirmed efficiency: ${effText}. Latest department snapshots (period ${n.latestPeriod}, ${n.latestDeptCount} departments): quality ${n.qualAvg}, capacity ${n.capAvg}%.`
      : `Confirmed efficiency: ${effText}. No department metrics snapshots on file.`
  );
  lines.push(`Pending approvals: ${n.pendingApprovals}.`);
  lines.push(`Brands by status: ${n.statusLine || "none"}.`);
  lines.push(`Data on file: ${n.platformRows} platform metric rows, ${n.snapCount} department snapshots.`);
  return lines.join("\n");
}

export interface RunOrgBriefingResult {
  status: "generated" | "insufficient" | "error";
  data_confidence: string;
  error?: string;
}

// Full generate + persist for ONE org. No auth, no revalidate — the caller owns
// those. generatedBy is null for a machine run (the GitHub Actions schedule has no user).
export async function runOrgBriefing(
  client: AnyClient,
  opts: { orgId: string; model: string; generatedBy: string | null; nowMs?: number }
): Promise<RunOrgBriefingResult> {
  const { orgId, model, generatedBy } = opts;
  const n = await gatherOrgBriefingNumbers(client, orgId, opts.nowMs);

  // Sufficiency guard: nothing trustworthy to brief on — honest note, no AI.
  if (!orgDataSufficient(n)) {
    await client.from("org_briefings").insert({
      org_id: orgId,
      period_start: n.period_start,
      period_end: n.period_end,
      data_confidence: "insufficient",
      summary: ORG_INSUFFICIENT_SUMMARY,
      chips: [],
      highlights: [],
      model,
      generated_by: generatedBy,
    });
    return { status: "insufficient", data_confidence: "insufficient" };
  }

  let data_confidence = orgBaseConfidence(n);
  let summary = "";
  let chips: Chip[] = [];
  let highlights: Highlight[] = [];

  try {
    const text = await anthropicMessages({
      model,
      system: ORG_SYSTEM_PROMPT,
      user: buildOrgUserPrompt(n),
      maxTokens: 1200,
    });
    const parsed = parseBriefingJson<{
      data_confidence?: string;
      summary?: string;
      chips?: Chip[];
      highlights?: Highlight[];
    }>(text);
    if (!parsed) throw new Error("could not parse model JSON");
    if (parsed.data_confidence) data_confidence = parsed.data_confidence;
    summary = parsed.summary ?? "";
    chips = Array.isArray(parsed.chips) ? parsed.chips.slice(0, 5) : [];
    highlights = Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 3) : [];
  } catch (e) {
    data_confidence = "insufficient";
    summary = `Could not generate an AI briefing (${
      e instanceof Error ? e.message : "unknown error"
    }). The KPIs and tables below are still read from your live data — try again shortly.`;
    chips = [];
    highlights = [];
  }

  await client.from("org_briefings").insert({
    org_id: orgId,
    period_start: n.period_start,
    period_end: n.period_end,
    data_confidence,
    summary,
    chips,
    highlights,
    model,
    generated_by: generatedBy,
  });
  return { status: summary && data_confidence !== "insufficient" ? "generated" : "error", data_confidence };
}
