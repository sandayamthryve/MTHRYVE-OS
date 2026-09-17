// lib/home/member-brief.ts — the member-scoped AI Brief.
//
// Given ONLY the member's own assignment — the brands on the pods they lead and
// their department's KPI-vs-target readings (both already loaded, member-scoped,
// by lib/home/unified) — this distils a short "root cause + top action today"
// brief. It reuses the Cognition/Tony READ layer (MetricReading, the deterministic
// actual-vs-target status) and the reused brand-health verdicts; it adds no data
// layer and issues no read of its own, so it CANNOT reach past the member's scope.
//
// Discipline (mirrors the Cognition Loop's grounding contract, enforced in code
// rather than by a prompt):
//   • READ-ONLY. It recommends; it never executes and never approves. Its one
//     suggested action links to a member-reachable tool — never an approve/run
//     button. A fix that needs a privileged change is flagged as routing to the
//     EXISTING approval gates (action_requests), which the member cannot trigger.
//   • MEMBER-SCOPED. Only the member's brands + their department KPIs feed it. No
//     cross-brand, no org-wide, and NO governance data (finance / P&L / audit) —
//     none of those sources are passed in.
//   • HONEST-DATA AWARE. A stale or missing metric reads "—" and is excluded from
//     reasoning; when nothing fresh is grounded the brief says "not enough fresh
//     data" rather than inventing a 0 or a false all-clear.
//
// There is deliberately NO model call here: like the Daily Tap's staff tier, the
// member brief is templated over real, deterministic readings — fast, and unable
// to fabricate. The badge reads "Grounded", not "AI synthesis".

import type { BrandTrigger } from "@/lib/quality/signal";
import type { BrandHealth, KpiVsTarget } from "@/lib/home/unified";
import type { MetricReading } from "@/lib/cognition/types";

// How recent a metric's latest period must be to count as "fresh". Older than
// this and the reading is treated as stale — it reads "—" and never drives a
// verdict (matches the trailing-7-day window the brand-health pass already uses).
const FRESH_MAX_AGE_DAYS = 7;

export type BriefSeverity = "critical" | "watch" | "steady" | "no_data";

// The one recommended next step. It is advisory only: `href` always points at a
// member-reachable tool, and `routesToApproval` marks moves whose real fix needs
// a head/COO sign-off through the existing gates — surfaced, never auto-run.
export interface BriefAction {
  label: string;
  href: string;
  rationale: string;
  routesToApproval: boolean;
}

export interface MemberBrief {
  // False when nothing fresh is grounded — the panel shows "not enough fresh data".
  hasFreshData: boolean;
  severity: BriefSeverity;
  // The most-likely driver, grounded in the cited brand/metric — null when steady
  // or when there is no fresh data to reason about.
  rootCause: string | null;
  // The exact reading the root cause rests on (e.g. "return rate 8.1% …" or the
  // metric's actual-vs-target status phrase). Null when steady / no data.
  evidence: string | null;
  topAction: BriefAction | null;
  // A plain sentence on what fed the brief and what was stale/missing.
  freshnessNote: string;
  freshCount: number; // grounded, fresh signals considered
  staleCount: number; // signals dropped as stale or unlogged (read "—")
}

const TRIGGER_TEXT: Record<BrandTrigger, string> = {
  return_rate_high: "return rate above the bar",
  fulfillment_errors_high: "a fulfillment-error spike",
  return_rate_rising: "a rising return rate",
};

// ── Freshness ───────────────────────────────────────────────────────────────
// A MetricReading's period is "period_start → period_end". Parse the end and
// judge it against today (both Manila YYYY-MM-DD). A missing/unparseable period
// is treated as NOT fresh — we never assume a metric is current when we can't tell.

function periodEnd(period: string | null): string | null {
  if (!period) return null;
  const parts = period.split("→");
  const end = (parts.length === 2 ? parts[1] : period).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null;
}

// Whole days from `end` up to `today` (both YYYY-MM-DD). Positive = end is in the
// past. null when either date is unparseable.
function daysAgo(end: string, today: string): number | null {
  const e = Date.parse(`${end}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(e) || !Number.isFinite(t)) return null;
  return Math.round((t - e) / 86_400_000);
}

function isFresh(r: MetricReading, today: string): boolean {
  if (!r.hasEntry) return false;
  const end = periodEnd(r.period);
  if (!end) return false;
  const age = daysAgo(end, today);
  // Fresh when within the window; a small negative (period ending "tomorrow" for
  // an in-progress week) still counts as current.
  return age != null && age <= FRESH_MAX_AGE_DAYS && age >= -2;
}

// ── Build ─────────────────────────────────────────────────────────────────────

export function buildMemberBrief(input: {
  brands: BrandHealth[];
  kpis: KpiVsTarget;
  openTasks: number;
  today: string;
}): MemberBrief {
  const { brands, kpis, openTasks, today } = input;

  // Brand health is already freshness-gated by the quality pass: a `no_data`
  // verdict means no rows in the trailing window (stale/missing), so only graded
  // brands (off_target / on_track) count as fresh signals.
  const gradedBrands = brands.filter((b) => b.verdict !== "no_data");
  const brandFires = gradedBrands.filter((b) => b.verdict === "off_target");

  // KPI readings: split into fresh-graded vs stale/missing. Only fresh readings
  // with a resolved R/A/G dot drive the verdict; the rest read "—".
  const freshReadings = kpis.readings.filter((r) => isFresh(r, today));
  const staleOrMissing = kpis.readings.length - freshReadings.length;
  const freshGraded = freshReadings.filter((r) => r.dot != null);
  const redKpi = freshGraded.find((r) => r.dot === "red") ?? null;
  const amberKpi = freshGraded.find((r) => r.dot === "amber") ?? null;

  const freshCount = gradedBrands.length + freshGraded.length;
  const staleCount = (brands.length - gradedBrands.length) + staleOrMissing;

  const freshnessNote = freshnessSentence(freshCount, staleCount);

  // No fresh grounded signal anywhere → say so plainly, recommend logging.
  if (freshCount === 0) {
    return {
      hasFreshData: false,
      severity: "no_data",
      rootCause: null,
      evidence: null,
      topAction: {
        label: "Log today's numbers",
        href: "/quick-entry",
        rationale:
          "Your brand and KPI feeds have no fresh entries — a grounded brief needs today's numbers first.",
        routesToApproval: false,
      },
      freshnessNote,
      freshCount,
      staleCount,
    };
  }

  // 1) An off-target brand is the sharpest signal — cite the brand + its triggers.
  if (brandFires.length > 0) {
    const b = brandFires[0];
    const name = b.brandName ?? "Your brand";
    const triggerText = b.triggers.map((t) => TRIGGER_TEXT[t]).join(" and ") || "a quality risk";
    return {
      hasFreshData: true,
      severity: "critical",
      rootCause: `${name} is off target — ${triggerText} in the trailing 7-day window.`,
      evidence: brandEvidence(b),
      topAction: {
        label: "Raise it on your board",
        href: "/tasks",
        rationale:
          "Open a task to investigate return reasons / fulfilment and log what you find. A listing or policy fix routes to the approval queue — nothing changes without a head's sign-off.",
        routesToApproval: true,
      },
      freshnessNote,
      freshCount,
      staleCount,
    };
  }

  // 2) A red KPI is next — cite the metric's own actual-vs-target status.
  if (redKpi) {
    return {
      hasFreshData: true,
      severity: "critical",
      rootCause: `${redKpi.label} is off target — ${redKpi.status}`,
      evidence: readingEvidence(redKpi),
      topAction: kpiAction(redKpi),
      freshnessNote,
      freshCount,
      staleCount,
    };
  }

  // 3) An amber KPI — worth a look today, not yet a fire.
  if (amberKpi) {
    return {
      hasFreshData: true,
      severity: "watch",
      rootCause: `${amberKpi.label} is at risk — ${amberKpi.status}`,
      evidence: readingEvidence(amberKpi),
      topAction: kpiAction(amberKpi),
      freshnessNote,
      freshCount,
      staleCount,
    };
  }

  // 4) Fresh data, nothing off target → honest steady state.
  return {
    hasFreshData: true,
    severity: "steady",
    rootCause: null,
    evidence: null,
    topAction:
      openTasks > 0
        ? {
            label: "Clear your board",
            href: "/tasks",
            rationale: `Every fresh metric is on target — your ${openTasks} open task${
              openTasks === 1 ? "" : "s"
            } are the highest-leverage move today.`,
            routesToApproval: false,
          }
        : {
            label: "Keep logging",
            href: "/quick-entry",
            rationale: "Every fresh metric is on target — keep today's numbers current to hold the read.",
            routesToApproval: false,
          },
    freshnessNote,
    freshCount,
    staleCount,
  };
}

// The recommended move for an off/at-risk KPI: log fresh numbers (the member's
// own lever), never an execute/approve action.
function kpiAction(r: MetricReading): BriefAction {
  return {
    label: "Log today's numbers",
    href: "/quick-entry",
    rationale: `Fresh entries on ${r.label} sharpen the read and drive the fix — logging is your lever; any broader change routes to the approval queue.`,
    routesToApproval: false,
  };
}

function brandEvidence(b: BrandHealth): string {
  const bits: string[] = [];
  if (b.returnRate != null) bits.push(`return rate ${Math.round(b.returnRate * 1000) / 10}%`);
  bits.push(`${b.orders} orders`);
  return bits.join(" · ");
}

function readingEvidence(r: MetricReading): string {
  return r.period ? `${r.status} (${r.period})` : r.status;
}

function freshnessSentence(freshCount: number, staleCount: number): string {
  if (freshCount === 0) {
    return "No fresh brand or KPI entries — nothing to ground a brief on yet.";
  }
  const fresh = `${freshCount} fresh signal${freshCount === 1 ? "" : "s"}`;
  if (staleCount === 0) return `Grounded on ${fresh}; nothing stale.`;
  return `Grounded on ${fresh}; ${staleCount} stale or unlogged, shown as "—".`;
}
