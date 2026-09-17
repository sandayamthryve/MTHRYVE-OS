// lib/automation-radar/detect.ts — the ONE org-wide Automation Radar detector.
//
// SERVER-ONLY. Deterministic, READ-ONLY over real rows: it scans public.tasks over
// a rolling window, normalizes titles, groups repeated work by
// (normalized_title + department + assignee), and — for groups that clear the
// threshold (>= MIN_OCCURRENCES with a roughly regular interval) — computes cadence
// and time cost, classifies how automatable each is (grounded ONLY in real
// capabilities / automation_registry rows), and UPSERTS into repetition_patterns.
//
// No fabrication: under threshold → no row. Nothing here executes anything — it
// only records patterns; proposing an automation (a pending action_request) is a
// separate, human-driven step in the surface. Runs under the SERVICE-ROLE client
// (org-wide, no request context), so every read/write is scoped by an explicit
// org_id — RLS is bypassed by design for this trusted job, exactly like the
// vesper worker and the other system producers.

// The tables this touches aren't all in the generated Database types, so — like
// the rest of the OS's newer surfaces — they're reached through the cast shim.
type Shim = { from: (t: string) => any };

// Rolling scan window and the minimum repetitions that count as a pattern. Under
// the threshold there is "not enough signal yet" — we never invent a pattern.
const WINDOW_DAYS = 90;
const MIN_OCCURRENCES = 3;

// How regular the intervals must be to count as a pattern. Coefficient of
// variation (stddev / mean of the gaps) — 0 is perfectly regular, ~1 is random.
// Lenient enough to keep real recurring work, strict enough to drop noise.
const REGULARITY_MAX_CV = 1.0;

// No per-task time metadata exists on tasks yet, so we use a sensible default for
// est_minutes_each. Kept explicit so it's honest in the UI ("est.") and easy to
// swap for real metadata later.
const DEFAULT_EST_MINUTES = 30;

// Judgment-heavy verbs: work that needs a human call each run. If a normalized
// title leads with / contains one of these, the pattern is 'keep_human' — never
// auto-run — regardless of cadence.
const JUDGMENT_TOKENS = new Set([
  "review",
  "decide",
  "approve",
  "negotiate",
  "strategy",
  "strategize",
  "evaluate",
  "assess",
  "hire",
  "interview",
  "brainstorm",
  "design",
  "plan",
  "escalate",
  "resolve",
  "investigate",
  "diagnose",
  "counsel",
  "coach",
  "mediate",
]);

const STOP_TOKENS = new Set([
  "the",
  "a",
  "an",
  "for",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "with",
  "task",
  "daily",
  "weekly",
  "monthly",
  "update",
  "check",
]);

const MONTHS =
  "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december";

// ── Normalization ─────────────────────────────────────────────────────────────
// Lowercase, then strip dates, numbers, IDs and punctuation so "Post Crayola reel
// #4 (2026-07-01)" and "post crayola reel 12 jul 3" collapse to the same key.
export function normalizeTitle(raw: string): string {
  let s = (raw ?? "").toLowerCase();
  // ISO + slashed dates (2026-07-01, 07/01/26)
  s = s.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ");
  s = s.replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, " ");
  // Month names (with optional day/year)
  s = s.replace(new RegExp(`\\b(${MONTHS})\\b\\.?\\s*\\d{0,4}`, "g"), " ");
  // week/day/day-of-week markers that only mark the instance, not the work
  s = s.replace(/\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, " ");
  s = s.replace(/\b(week|wk|day|q)\s*\d+\b/g, " ");
  // UUID-ish / long hex IDs
  s = s.replace(/\b[0-9a-f]{6,}\b/g, " ");
  // any remaining standalone numbers (and #-prefixed)
  s = s.replace(/#?\b\d+\b/g, " ");
  // punctuation → space
  s = s.replace(/[^a-z\s]/g, " ");
  // collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function tokenize(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t));
}

// ── Cadence + regularity ──────────────────────────────────────────────────────
function inferCadence(avgIntervalDays: number): string {
  if (avgIntervalDays <= 2) return "daily";
  if (avgIntervalDays <= 10) return "weekly";
  if (avgIntervalDays <= 20) return "biweekly";
  if (avgIntervalDays <= 45) return "monthly";
  return "irregular";
}

const REGULAR_CADENCES = new Set(["daily", "weekly", "biweekly", "monthly"]);

interface IntervalStats {
  avgIntervalDays: number;
  cv: number; // coefficient of variation of the gaps
}

// Gaps (in days) between consecutive occurrences → mean + coefficient of variation.
function intervalStats(sortedDates: number[]): IntervalStats | null {
  if (sortedDates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const days = (sortedDates[i] - sortedDates[i - 1]) / (1000 * 60 * 60 * 24);
    gaps.push(days);
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return null;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;
  return { avgIntervalDays: mean, cv };
}

// ── Grounded classification ───────────────────────────────────────────────────
export interface CapabilityLite {
  id: string;
  name: string;
  status: string; // 'live' | 'partial' | 'planned' | 'vendor'
  outputs: string[];
}
export interface AutomationLite {
  key: string;
  name: string | null;
  enabled: boolean;
}

export interface Classification {
  automatability: "automatable" | "templatable" | "sop" | "keep_human";
  suggested_path: string | null;
  matched_capability_id: string | null;
  matched_workflow: string | null;
}

// Best live/partial capability whose name/outputs share a meaningful token with the
// work. Conservative: requires a shared token of length >= 4 so we never invent a
// match. Returns the highest-overlap capability, tie-broken live > partial.
function matchCapability(titleTokens: string[], caps: CapabilityLite[]): CapabilityLite | null {
  const wanted = new Set(titleTokens.filter((t) => t.length >= 4));
  if (wanted.size === 0) return null;
  let best: { cap: CapabilityLite; score: number } | null = null;
  for (const cap of caps) {
    if (cap.status !== "live" && cap.status !== "partial") continue;
    const hay = new Set(
      tokenize(`${cap.name} ${(cap.outputs ?? []).join(" ")}`.toLowerCase()).filter((t) => t.length >= 4)
    );
    let score = 0;
    for (const t of wanted) if (hay.has(t)) score += 1;
    if (score === 0) continue;
    const boosted = score + (cap.status === "live" ? 0.5 : 0);
    if (!best || boosted > best.score) best = { cap, score: boosted };
  }
  return best?.cap ?? null;
}

function matchAutomation(titleTokens: string[], autos: AutomationLite[]): AutomationLite | null {
  const wanted = new Set(titleTokens.filter((t) => t.length >= 4));
  if (wanted.size === 0) return null;
  let best: { auto: AutomationLite; score: number } | null = null;
  for (const a of autos) {
    if (!a.enabled) continue;
    const hay = new Set(tokenize((a.name ?? a.key).toLowerCase()).filter((t) => t.length >= 4));
    let score = 0;
    for (const t of wanted) if (hay.has(t)) score += 1;
    if (score === 0) continue;
    if (!best || score > best.score) best = { auto: a, score };
  }
  return best?.auto ?? null;
}

// Classify a pattern, grounded ONLY in real rows. Precedence:
//   keep_human (judgment verb) → automatable (live capability/workflow) →
//   templatable (regular cadence) → sop (repeatable but manual).
export function classifyPattern(
  normalizedTitle: string,
  cadence: string,
  caps: CapabilityLite[],
  autos: AutomationLite[]
): Classification {
  const tokens = tokenize(normalizedTitle);

  // 1. Judgment-heavy → keep_human (one-line reason).
  const judgment = tokens.find((t) => JUDGMENT_TOKENS.has(t));
  if (judgment) {
    return {
      automatability: "keep_human",
      suggested_path: `Keep human — "${judgment}" needs a judgment call each run.`,
      matched_capability_id: null,
      matched_workflow: null,
    };
  }

  // 2. A LIVE capability or enabled workflow already covers it → automatable.
  const cap = matchCapability(tokens, caps);
  if (cap) {
    return {
      automatability: "automatable",
      suggested_path: `Link Vesper Core capability "${cap.name}" (${cap.status}).`,
      matched_capability_id: cap.id,
      matched_workflow: null,
    };
  }
  const auto = matchAutomation(tokens, autos);
  if (auto) {
    return {
      automatability: "automatable",
      suggested_path: `Wire the "${auto.name ?? auto.key}" workflow (automation_registry: ${auto.key}).`,
      matched_capability_id: null,
      matched_workflow: auto.key,
    };
  }

  // 3. Regular cadence, low judgment → a recurring task template.
  if (REGULAR_CADENCES.has(cadence)) {
    return {
      automatability: "templatable",
      suggested_path: `Create a recurring ${cadence} task template so it self-generates.`,
      matched_capability_id: null,
      matched_workflow: null,
    };
  }

  // 4. Repeatable but manual and irregular → write an SOP.
  return {
    automatability: "sop",
    suggested_path: "Document an SOP so anyone can run it consistently.",
    matched_capability_id: null,
    matched_workflow: null,
  };
}

// ── Row shapes read from the DB ───────────────────────────────────────────────
type TaskRow = {
  id: string;
  title: string | null;
  assignee_id: string | null;
  created_at: string | null;
  status: string | null;
};
type UserRow = { id: string; department_id: string | null };
type DeptRow = { id: string; name: string | null };

interface Group {
  normalized: string;
  department: string | null;
  assignee_id: string | null;
  titles: string[];
  dates: number[];
}

export interface DetectionSummary {
  org_id: string;
  scanned_tasks: number;
  groups_considered: number;
  patterns_upserted: number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Detect + upsert patterns for ONE org. Deterministic; returns a small summary.
export async function detectForOrg(db: Shim, orgId: string): Promise<DetectionSummary> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const [taskRes, userRes, deptRes, capRes, autoRes] = await Promise.all([
    db
      .from("tasks")
      .select("id, title, assignee_id, created_at, status")
      .eq("org_id", orgId)
      .gte("created_at", since),
    db.from("users").select("id, department_id").eq("org_id", orgId),
    db.from("departments").select("id, name").eq("org_id", orgId),
    // capabilities/automation_registry are org-scoped; grounded matches only.
    db.from("capabilities").select("id, name, status, outputs").eq("org_id", orgId),
    db.from("automation_registry").select("key, name, enabled").eq("org_id", orgId),
  ]);

  const tasks = (taskRes?.data ?? []) as TaskRow[];
  const users = (userRes?.data ?? []) as UserRow[];
  const depts = (deptRes?.data ?? []) as DeptRow[];
  const caps = ((capRes?.data ?? []) as Array<{ id: string; name: string | null; status: string | null; outputs: unknown }>).map(
    (c) => ({
      id: String(c.id),
      name: String(c.name ?? ""),
      status: String(c.status ?? "planned"),
      outputs: Array.isArray(c.outputs) ? (c.outputs as unknown[]).filter((x): x is string => typeof x === "string") : [],
    })
  ) as CapabilityLite[];
  const autos = ((autoRes?.data ?? []) as Array<{ key: string; name: string | null; enabled: unknown }>).map((a) => ({
    key: String(a.key),
    name: a.name == null ? null : String(a.name),
    enabled: a.enabled === true,
  })) as AutomationLite[];

  const deptNameById = new Map(depts.map((d) => [d.id, d.name ?? null]));
  const deptByUser = new Map(users.map((u) => [u.id, u.department_id]));

  // Group by normalized_title + department + assignee.
  const groups = new Map<string, Group>();
  let scanned = 0;
  for (const t of tasks) {
    if (!t.title) continue;
    const ts = t.created_at ? new Date(t.created_at).getTime() : NaN;
    if (!Number.isFinite(ts)) continue;
    scanned++;
    const normalized = normalizeTitle(t.title);
    if (!normalized || tokenize(normalized).length === 0) continue;

    const deptId = t.assignee_id ? deptByUser.get(t.assignee_id) ?? null : null;
    const department = deptId ? deptNameById.get(deptId) ?? null : null;
    const key = `${department ?? "unassigned"}::${normalized}::${t.assignee_id ?? "any"}`;

    const g =
      groups.get(key) ??
      (() => {
        const ng: Group = { normalized, department, assignee_id: t.assignee_id, titles: [], dates: [] };
        groups.set(key, ng);
        return ng;
      })();
    if (g.titles.length < 5 && !g.titles.includes(t.title)) g.titles.push(t.title);
    g.dates.push(ts);
  }

  // Build + upsert the patterns that clear the threshold.
  const rows: Record<string, unknown>[] = [];
  for (const g of groups.values()) {
    if (g.dates.length < MIN_OCCURRENCES) continue; // under threshold → no pattern
    const sorted = [...g.dates].sort((a, b) => a - b);
    const stats = intervalStats(sorted);
    if (!stats) continue;
    if (stats.cv > REGULARITY_MAX_CV) continue; // not a roughly regular interval → skip

    const cadence = inferCadence(stats.avgIntervalDays);
    const est = DEFAULT_EST_MINUTES;
    const monthlyFreq = 30 / stats.avgIntervalDays; // occurrences per month
    const timeCostPerMonth = Math.round(est * monthlyFreq);
    const cls = classifyPattern(g.normalized, cadence, caps, autos);
    const patternKey = `${g.department ?? "unassigned"}::${g.normalized}::${g.assignee_id ?? "any"}`;

    rows.push({
      org_id: orgId,
      pattern_key: patternKey,
      normalized_title: g.normalized,
      sample_titles: g.titles,
      department: g.department,
      assignee_id: g.assignee_id,
      occurrences: g.dates.length,
      first_seen: isoDate(sorted[0]),
      last_seen: isoDate(sorted[sorted.length - 1]),
      cadence,
      avg_interval_days: Math.round(stats.avgIntervalDays * 10) / 10,
      est_minutes_each: est,
      time_cost_per_month: timeCostPerMonth,
      automatability: cls.automatability,
      suggested_path: cls.suggested_path,
      matched_capability_id: cls.matched_capability_id,
      matched_workflow: cls.matched_workflow,
      // Only (re)set to 'detected' on fresh detection; never clobber a human's
      // 'proposed'/'dismissed'/'approved'/'automated' — handled by the upsert
      // ignoring status on conflict below.
      updated_at: new Date().toISOString(),
    });
  }

  let upserted = 0;
  if (rows.length > 0) {
    // Upsert on (org_id, pattern_key). We intentionally DON'T write status here so
    // a re-scan refreshes the metrics/classification without resetting a pattern a
    // human already proposed or dismissed. New rows default to 'detected' (DB default).
    const { error } = await db
      .from("repetition_patterns")
      .upsert(rows, { onConflict: "org_id,pattern_key" });
    if (!error) upserted = rows.length;
  }

  return {
    org_id: orgId,
    scanned_tasks: scanned,
    groups_considered: groups.size,
    patterns_upserted: upserted,
  };
}

// Run detection across every org (the ONE engine, org-wide). Service-role client.
export async function runDetection(db: Shim): Promise<DetectionSummary[]> {
  const { data } = await db.from("organizations").select("id");
  const orgs = ((data ?? []) as Array<{ id: string }>).map((o) => o.id);
  const summaries: DetectionSummary[] = [];
  for (const orgId of orgs) {
    try {
      summaries.push(await detectForOrg(db, orgId));
    } catch {
      // one org failing must never sink the rest
      summaries.push({ org_id: orgId, scanned_tasks: 0, groups_considered: 0, patterns_upserted: 0 });
    }
  }
  return summaries;
}
