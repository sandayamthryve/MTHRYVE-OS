// lib/daily-tap/build.ts — turns one active user into their morning tap.
//
// Tier dispatch (see tierForRole):
//   • leadership (ceo/coo) — the fuller digest with the ONE Sonnet synthesis
//     (lib/daily-tap/leadership.ts). ai_used=true only when that call returns.
//   • head (department_head) — TEMPLATED: the head's department metrics vs target
//     (R/A/G), the pending approvals awaiting a head decision, and a link to
//     their fuller brief. No model call.
//   • staff (everyone else) — TEMPLATED: their department's key metrics vs target,
//     one focus line, and the "log today's Quick Entry" nudge. No model call.
//
// Everything is grounded in real rows. A metric with no entry reads "log today's
// numbers"; a department with no mapped compartment says so plainly. Nothing is
// invented, and nothing here acts — a tap is a read.

import {
  compartmentCodesForDepartment,
  readOrgReadings,
  verdictWord,
  type TapReading,
} from "@/lib/daily-tap/metrics";
import { readLeadershipSignals, buildLeadershipBody } from "@/lib/daily-tap/leadership";
import { tierForRole, tapLink, type BuiltTap, type TapTier, type TapUser } from "@/lib/daily-tap/types";

type Shim = { from: (t: string) => any };

function firstName(full: string | null): string {
  const n = (full ?? "").trim().split(/\s+/)[0];
  return n || "there";
}

// One honest metric line. No entry → "log today's numbers" (never a fabricated
// figure). Graded → "value vs target T · verdict". Ungraded-but-present → the
// value with an honest "no target set".
function metricLine(r: TapReading): string {
  if (!r.hasEntry) return `  • ${r.label} — log today's numbers`;
  if (r.dot) {
    const vs = r.targetText ? ` vs target ${r.targetText}` : "";
    return `  • ${r.label} — ${r.valueText}${vs} · ${verdictWord(r.dot)}`;
  }
  return r.targetText
    ? `  • ${r.label} — ${r.valueText} vs target ${r.targetText}`
    : `  • ${r.label} — ${r.valueText} · no target set`;
}

// The one focus line for a staff tap: the first off-target fire, else the first
// un-logged metric (a nudge to log), else steady-state.
function focusLine(readings: TapReading[]): string {
  const red = readings.find((r) => r.dot === "red");
  if (red) return `Focus: ${red.label} is off target — your entries drive the fix.`;
  const amber = readings.find((r) => r.dot === "amber");
  if (amber) return `Focus: ${amber.label} is at risk — worth a look today.`;
  const missing = readings.find((r) => !r.hasEntry);
  if (missing) return `Focus: ${missing.label} has no entry yet — log today's number.`;
  return "Focus: every tracked metric is on target — keep it steady.";
}

// Count pending approvals a department head can actually decide (required_role =
// 'department_head'). Org-scoped explicitly (service-role client, no RLS).
async function countHeadApprovals(db: Shim, orgId: string): Promise<number> {
  try {
    const { count } = await db
      .from("action_requests")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "pending")
      .eq("required_role", "department_head");
    return count ?? 0;
  } catch {
    return 0;
  }
}

// The user's OPEN tagged tasks (Snap-Tag), for their morning brief. Two plain
// queries — tag rows for the user, then the still-open, non-archived tasks among
// them — so there's no embed-typing fragility. Honest nulls: no open tagged
// tasks reads "none open right now"; a task with no due date says so plainly; a
// FAILED read adds nothing (we never claim "none" when we don't actually know).
async function taggedTasksSection(db: Shim, orgId: string, userId: string): Promise<string> {
  try {
    const { data: tagRows } = await db
      .from("task_tags")
      .select("task_id")
      .eq("org_id", orgId)
      .eq("user_id", userId);
    const ids = ((tagRows as Array<{ task_id: string }> | null) ?? []).map((r) => r.task_id);
    if (ids.length === 0) return "Tagged to you\n  • none open right now.";

    const { data: taskRows } = await db
      .from("tasks")
      .select("title, due_date, status")
      .in("id", ids)
      .is("archived_at", null)
      .not("status", "in", "(done,cancelled)")
      .order("due_date", { ascending: true, nullsFirst: false });
    const tasks =
      (taskRows as Array<{ title: string; due_date: string | null; status: string }> | null) ?? [];
    if (tasks.length === 0) return "Tagged to you\n  • none open right now.";

    const shown = tasks.slice(0, 8).map((t) => {
      const due = t.due_date ? `due ${t.due_date}` : "no due date";
      return `  • ${t.title} — ${due} · ${t.status}`;
    });
    if (tasks.length > 8) shown.push(`  • …and ${tasks.length - 8} more`);
    return ["Tagged to you", ...shown].join("\n");
  } catch {
    // Best-effort — a failed read simply omits the section (never a false "none").
    return "";
  }
}

function dateLabel(today: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(new Date(`${today}T00:00:00+08:00`));
  } catch {
    return today;
  }
}

// Build the leadership (ceo/coo) tap — the ONE model-backed branch.
async function buildLeadershipTap(db: Shim, user: TapUser): Promise<BuiltTap> {
  const sig = await readLeadershipSignals(db, user.org_id);
  const { body, aiUsed } = await buildLeadershipBody(db, user.org_id, user.id, sig);
  const link = tapLink("leadership");
  const summary = [`Good morning, ${firstName(user.full_name)}.`, "", body, "", `→ ${link.label}.`].join("\n");
  return { tier: "leadership", title: "Your morning brief", summary, aiUsed };
}

// Build a department-scoped templated tap (head or staff). No model call.
async function buildDeptTap(db: Shim, user: TapUser, tier: Exclude<TapTier, "leadership">): Promise<BuiltTap> {
  const { codes, label } = await compartmentCodesForDepartment(db, await departmentName(db, user.department_id));
  const readings = codes.length ? await readOrgReadings(db, user.org_id, codes) : [];
  const link = tapLink(tier);
  const deptLabel = label ?? "Your department";

  const lines: string[] = [`Good morning, ${firstName(user.full_name)}.`, ""];

  if (readings.length === 0) {
    lines.push(
      `${deptLabel} — no metrics compartment is mapped to your department yet.`,
      "Log today's numbers in Quick Entry so tomorrow's tap can grade them."
    );
  } else {
    lines.push(`${deptLabel} — metrics vs target`, ...readings.map(metricLine));
  }

  if (tier === "head") {
    lines.push("");
    const approvals = await countHeadApprovals(db, user.org_id);
    lines.push(
      approvals > 0
        ? `Pending approvals: ${approvals} awaiting your decision (surfaced for review — nothing auto-approves).`
        : "Pending approvals: none awaiting your decision."
    );
  } else {
    lines.push("", focusLine(readings));
  }

  lines.push("", `→ ${link.label}.`);
  const title = tier === "head" ? "Your department brief" : "Your daily tap";
  return { tier, title, summary: lines.join("\n"), aiUsed: false };
}

async function departmentName(db: Shim, departmentId: string | null): Promise<string | null> {
  if (!departmentId) return null;
  try {
    const { data } = await db.from("departments").select("name").eq("id", departmentId).maybeSingle();
    return (data as { name?: string } | null)?.name ?? null;
  } catch {
    return null;
  }
}

// Build the tap for one user, dispatching by tier. Never throws — a failure in a
// sub-read degrades to an honest, thinner brief rather than skipping the user.
export async function buildTap(db: Shim, user: TapUser, today: string): Promise<BuiltTap> {
  const tier = tierForRole(user.role);
  const tap = tier === "leadership" ? await buildLeadershipTap(db, user) : await buildDeptTap(db, user, tier);
  // Every tier's brief carries the user's OPEN tagged tasks (Snap-Tag).
  const tagged = await taggedTasksSection(db, user.org_id, user.id);
  const summary = tagged ? `${tap.summary}\n\n${tagged}` : tap.summary;
  // Stamp the date into the title so the notification + inbox read unambiguously.
  return { ...tap, summary, title: `${tap.title} · ${dateLabel(today)}` };
}
